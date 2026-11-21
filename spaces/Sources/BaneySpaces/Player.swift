import AppKit
import AVFoundation
import AVKit
import BaneySpacesCore
import ImageIO
import MediaPlayer
import QuartzCore

/// Polycarp's player: songs, videos and photos, one thing in front and nothing noisy (spec/player.md). One window,
/// made the first time and reused, so a warm open only swaps what it shows. Photos are decoded at screen size off the
/// main thread, and the photos either side are decoded before you ask for them. The rules it follows (which files,
/// the folder playlist, the keys, where a long video picks up again) are pure and tested in BaneySpacesCore.
enum Player {
    /// Shows `url` in the player, with the rest of its folder as the playlist. The one call for the CLI
    /// (`polycarp-spaces play`), Finder's Open With and, later, the launcher. Main thread; never waits on the disk.
    static func open(_ url: URL) { PlayerController.shared.open(url) }

    /// Whether the player opens this file (by its extension: no disk read).
    static func canOpen(_ url: URL) -> Bool { url.isFileURL && PlayerMedia.kind(of: url.path) != nil }
}

extension AppDelegate {
    /// Finder's Open With, a file dropped on Polycarp, `open -b com.baney.polycarp <file>`. Polycarp is only ever an
    /// alternate handler (Info.plist), so it opens what you send it and never claims a type for itself. The first file
    /// it opens wins; the player's playlist is that file's folder.
    /// A `polycarp://` link that starts Polycarp lands here too, before `handleURL` is installed; it runs once launch
    /// has finished.
    @objc(application:openURLs:)
    func application(_ sender: NSApplication, open urls: [URL]) {
        let route = PlayerOpen.route(urls)
        if let media = route.media { Player.open(media) }
        for link in route.links { DispatchQueue.main.async { self.runURL(link) } }
    }
}

// MARK: - The controller

final class PlayerController: NSObject, NSWindowDelegate {
    static let shared = PlayerController()

    private var window: PlayerWindow?
    private var stage: PlayerStage!
    private let player = AVPlayer()

    private var playlist = PlayerPlaylist(single: "/")
    private var kind: MediaKind = .photo
    /// Goes up with every file shown, so late work for an earlier one is dropped.
    private var generation = 0
    private var openedAt = DispatchTime.now()

    // Photos: decoded at screen size, kept for the one showing and its neighbors.
    private let decodeQueue = DispatchQueue(label: "polycarp.player.decode", qos: .userInteractive)
    private let prefetchQueue = DispatchQueue(label: "polycarp.player.prefetch", qos: .utility)
    private var cache: [String: CGImage] = [:]
    private var cacheOrder: [String] = []
    private var pending: Set<String> = []
    /// The current photo and its neighbors, read by the decode queues: a decode for a photo already passed is skipped.
    private let wants = PhotoWants()
    private var wanted: String?
    private var animating = 0

    // Timed media.
    private var statusWatch: NSKeyValueObservation?
    private var displayWatch: NSKeyValueObservation?
    private var timeWatch: Any?
    private var endWatch: NSObjectProtocol?
    private var waitingToSeek: Double?
    private var resumeClock = PlayerResumeClock()
    private var metadata = NowPlaying.Info()

    // Long videos pick up where you left them.
    private let io = DispatchQueue(label: "polycarp.player.io", qos: .utility)
    private var resume = PlayerResume()
    private var resumeLoaded = false
    private static var resumeFile: URL { Spaces.folder.appendingPathComponent("player-resume.json") }

    // Chrome.
    private var idleTimer: Timer?
    private var savedFrame: NSRect?
    private var savedOptions: NSApplication.PresentationOptions = []
    private var infoShown = false

    // MARK: Open

    func open(_ url: URL) {
        precondition(Thread.isMainThread)
        let path = url.standardizedFileURL.path
        guard let k = PlayerMedia.kind(of: path) else { return }
        openedAt = DispatchTime.now()
        let w = ensureWindow()
        loadResumeOnce()
        leaveCurrent()
        playlist = PlayerPlaylist(single: path)
        show(path, kind: k)
        NSApp.activate(ignoringOtherApps: true)
        w.makeKeyAndOrderFront(nil)
        pokeChrome()
        readFolder(of: path)
    }

    /// The folder's other media, read off the main thread; the playlist keeps the file showing.
    private func readFolder(of path: String) {
        let gen = generation
        io.async { [weak self] in
            let folder = (path as NSString).deletingLastPathComponent
            let names = (try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? []
            let list = PlayerPlaylist.make(opened: path, names: names)
            DispatchQueue.main.async {
                guard let self, self.generation == gen else { return }
                self.playlist = list
                self.stage.chrome.position = list.position
                self.prefetchNeighbors()
            }
        }
    }

    private func step(_ by: Int) {
        guard let i = playlist.neighbor(by) else { return }
        go(to: i)
    }

    private func go(to i: Int) {
        openedAt = DispatchTime.now()
        leaveCurrent()
        playlist.index = i
        let path = playlist.current
        show(path, kind: PlayerMedia.kind(of: path) ?? .photo)
        pokeChrome()
    }

    /// Notes where a long video was and stops anything still running for the file going away.
    private func leaveCurrent() {
        noteResume(save: true)
        generation += 1
        animating += 1
        wanted = nil
        waitingToSeek = nil
        statusWatch = nil
        displayWatch = nil
        if let endWatch { NotificationCenter.default.removeObserver(endWatch) }
        endWatch = nil
        player.pause()
    }

    private func show(_ path: String, kind k: MediaKind) {
        kind = k
        stage.message = nil
        updateWants()
        // Not drawn (the title bar is hidden), but window lists and the Accessibility tree name the file.
        window?.title = (path as NSString).lastPathComponent
        stage.chrome.configure(title: (path as NSString).lastPathComponent, kind: k, position: playlist.position)
        if infoShown { refreshInfo() }
        switch k {
        case .photo: showPhoto(path)
        case .audio, .video: showTimed(path, kind: k)
        }
    }

    // MARK: Photos

    /// The screen the player is on, in pixels: photos are decoded to fill it, so filling the screen needs no new decode.
    private var screenPixels: CGSize {
        let s = window?.screen ?? NSScreen.main
        let size = s?.frame.size ?? CGSize(width: 1920, height: 1080)
        let scale = s?.backingScaleFactor ?? 2
        return CGSize(width: size.width * scale, height: size.height * scale)
    }

    private func key(_ path: String) -> String { "\(Int(screenPixels.width))x\(Int(screenPixels.height))|\(path)" }

    private func showPhoto(_ path: String) {
        if player.currentItem != nil { player.replaceCurrentItem(with: nil) }
        NowPlaying.detach()
        stage.mode = .photo
        let k = key(path)
        if let image = cache[k] {
            present(image, path: path, how: "cached")
        } else {
            stage.photo.contents = nil
            wanted = k
            if !pending.contains(k) { decode(path, on: decodeQueue) }
        }
        prefetchNeighbors()
    }

    private func decode(_ path: String, on queue: DispatchQueue) {
        let k = key(path), screen = screenPixels
        pending.insert(k)
        queue.async { [weak self, wants] in
            guard wants.contains(k) else {
                DispatchQueue.main.async { self?.skipped(k, path: path) }
                return
            }
            let image = PhotoDecode.image(at: URL(fileURLWithPath: path), screen: screen)
            DispatchQueue.main.async {
                guard let self else { return }
                self.pending.remove(k)
                guard let image else {
                    if self.wanted == k { self.stage.message = "macOS can't read this photo." }
                    return
                }
                self.remember(image, for: k)
                if self.wanted == k, self.playlist.current == path { self.present(image, path: path, how: "decoded") }
            }
        }
    }

    /// A queued decode found its photo passed. If it is wanted again by now, it goes back on a queue.
    private func skipped(_ k: String, path: String) {
        pending.remove(k)
        if wanted == k, playlist.current == path { decode(path, on: decodeQueue) }
        else if playlist.prefetch.contains(path), cache[k] == nil, window?.isVisible == true { decode(path, on: prefetchQueue) }
    }

    private func updateWants() {
        wants.set(Set(([playlist.current] + playlist.prefetch).filter { PlayerMedia.kind(of: $0) == .photo }.map(key)))
    }

    private func prefetchNeighbors() {
        updateWants()
        guard window?.isVisible == true else { return }
        for path in playlist.prefetch where cache[key(path)] == nil && !pending.contains(key(path)) {
            decode(path, on: prefetchQueue)
        }
    }

    /// Keeps the one showing and its two neighbors, and the one before when it was just left: a 12-megapixel photo
    /// decoded whole is 48 MB, so no more than four are held.
    private func remember(_ image: CGImage, for k: String) {
        cache[k] = image
        cacheOrder.removeAll { $0 == k }
        cacheOrder.append(k)
        let keep = Set(([playlist.current] + playlist.prefetch).map(key))
        while cache.count > 4, let drop = cacheOrder.first(where: { !keep.contains($0) }) {
            cache[drop] = nil
            cacheOrder.removeAll { $0 == drop }
        }
    }

    private func present(_ image: CGImage, path: String, how: String) {
        wanted = nil
        let started = openedAt
        let gen = generation
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        CATransaction.setCompletionBlock { [weak self] in
            self?.trace("photo first frame \(Self.ms(since: started)) ms (\(how), \(image.width)x\(image.height))")
        }
        stage.photo.contents = image
        CATransaction.commit()
        animateIfNeeded(path, gen: gen)
    }

    /// A GIF with more than one frame plays, on the main queue, until another file is shown.
    private func animateIfNeeded(_ path: String, gen: Int) {
        guard (path as NSString).pathExtension.lowercased() == "gif" else { return }
        let token = animating
        io.async { [weak self] in
            guard PhotoDecode.frameCount(at: URL(fileURLWithPath: path)) > 1 else { return }
            DispatchQueue.main.async {
                guard let self, self.generation == gen, self.animating == token else { return }
                CGAnimateImageAtURLWithBlock(URL(fileURLWithPath: path) as CFURL, nil) { [weak self] _, image, stop in
                    guard let self, self.animating == token else { stop.pointee = true; return }
                    CATransaction.begin()
                    CATransaction.setDisableActions(true)
                    self.stage.photo.contents = image
                    CATransaction.commit()
                }
            }
        }
    }

    // MARK: Songs and videos

    private func showTimed(_ path: String, kind k: MediaKind) {
        stage.mode = k == .video ? .video : .audio
        stage.photo.contents = nil
        resumeClock.newItem()
        let url = URL(fileURLWithPath: path)
        let item = AVPlayerItem(asset: AVURLAsset(url: url))
        let gen = generation
        let started = openedAt
        // A file with a saved place waits for it; anything else starts at once.
        let resumeHere = resumeLoaded && k == .video && resume.has(path)
        statusWatch = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            DispatchQueue.main.async { self?.statusChanged(item, path: path, kind: k, gen: gen, started: started) }
        }
        if k == .video {
            displayWatch = stage.video.observe(\.isReadyForDisplay, options: [.new]) { [weak self] view, _ in
                DispatchQueue.main.async {
                    guard let self, self.generation == gen, view.isReadyForDisplay else { return }
                    self.displayWatch = nil
                    self.trace("video first frame \(Self.ms(since: started)) ms")
                }
            }
        }
        endWatch = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            self?.ended(gen: gen)
        }
        player.replaceCurrentItem(with: item)
        if resumeHere { waitingToSeek = 0 } else { player.play() }
        metadata = NowPlaying.Info(title: (path as NSString).lastPathComponent)
        if k == .audio {
            stage.audio.show(title: metadata.title, artist: nil, artwork: nil)
            loadTags(url, gen: gen)
        }
        NowPlaying.attach(self)
        updateNowPlaying()
        stage.chrome.playing = !resumeHere
        if timeWatch == nil {
            timeWatch = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 4), queue: .main) { [weak self] _ in
                self?.tick()
            }
        }
    }

    private func statusChanged(_ item: AVPlayerItem, path: String, kind k: MediaKind, gen: Int, started: DispatchTime) {
        guard generation == gen else { return }
        switch item.status {
        case .failed:
            player.replaceCurrentItem(with: nil)
            stage.mode = .photo
            stage.message = PlayerMedia.cannotPlay(path)
            NowPlaying.detach()
            trace("\(k.rawValue) can't play .\((path as NSString).pathExtension.lowercased())")
        case .readyToPlay:
            statusWatch = nil
            trace("\(k.rawValue) ready \(Self.ms(since: started)) ms")
            let duration = item.duration.seconds
            if waitingToSeek != nil {
                waitingToSeek = nil
                if let at = resume.position(for: path, duration: duration) {
                    resumeClock.seekStarted()
                    item.seek(to: CMTime(seconds: at, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
                        DispatchQueue.main.async {
                            guard let self, self.generation == gen else { return }
                            self.resumeClock.seekEnded(at: at)
                            self.player.play()
                            self.tick()
                        }
                    }
                } else {
                    player.play()
                }
            } else if let at = resume.position(for: path, duration: duration), player.currentTime().seconds < 5 {
                // The saved places were still loading when this opened: jump now.
                resumeClock.seekStarted()
                item.seek(to: CMTime(seconds: at, preferredTimescale: 600)) { [weak self] _ in
                    DispatchQueue.main.async { if self?.generation == gen { self?.resumeClock.seekEnded(at: at) } }
                }
            }
            stage.chrome.playing = player.rate != 0 || player.timeControlStatus == .waitingToPlayAtSpecifiedRate
            metadata.duration = duration
            updateNowPlaying()
            tick()
        default: break
        }
    }

    /// A song that ends goes to the next song in the folder; a video stops on its last frame.
    private func ended(gen: Int) {
        guard generation == gen else { return }
        noteResume(save: true)
        if kind == .audio, let next = playlist.neighbor(1, kinds: [.audio]) { go(to: next); return }
        stage.chrome.playing = false
        updateNowPlaying()
    }

    private func loadTags(_ url: URL, gen: Int) {
        let asset = AVURLAsset(url: url)
        Task.detached(priority: .utility) { [weak self] in
            let items = (try? await asset.load(.commonMetadata)) ?? []
            func text(_ key: AVMetadataKey) async -> String? {
                guard let i = AVMetadataItem.metadataItems(from: items, withKey: key, keySpace: .common).first else { return nil }
                return try? await i.load(.stringValue)
            }
            let title = await text(.commonKeyTitle), artist = await text(.commonKeyArtist), album = await text(.commonKeyAlbumName)
            var art: NSImage?
            if let i = AVMetadataItem.metadataItems(from: items, withKey: AVMetadataKey.commonKeyArtwork, keySpace: .common).first,
               let data = try? await i.load(.dataValue) { art = NSImage(data: data) }
            await MainActor.run { [weak self, art] in
                guard let self, self.generation == gen else { return }
                if let title, !title.isEmpty { self.metadata.title = title }
                self.metadata.artist = artist
                self.metadata.album = album
                self.metadata.artwork = art
                self.stage.audio.show(title: self.metadata.title, artist: [artist, album].compactMap { $0 }.joined(separator: " · "), artwork: art)
                self.updateNowPlaying()
            }
        }
    }

    private func tick() {
        guard kind.timed, let item = player.currentItem else { return }
        let now = player.currentTime().seconds, total = item.duration.seconds
        stage.chrome.time(now, of: total)
        if resumeClock.tick(now) { noteResume(save: true) }
    }

    // MARK: Commands

    func togglePlay() {
        guard kind.timed, player.currentItem != nil else { return }
        if player.rate == 0 {
            if let item = player.currentItem, item.currentTime() >= item.duration { item.seek(to: .zero, completionHandler: nil) }
            player.play()
        } else {
            player.pause()
            noteResume(save: true)
        }
        stage.chrome.playing = player.rate != 0
        updateNowPlaying()
        pokeChrome()
    }

    func seek(by seconds: Double) { seek(to: player.currentTime().seconds + seconds) }

    func seek(to seconds: Double) {
        guard kind.timed, let item = player.currentItem else { return }
        let total = item.duration.seconds
        let at = max(0, total.isFinite ? min(seconds, total - 0.1) : seconds)
        player.seek(to: CMTime(seconds: at, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            self?.updateNowPlaying()
        }
        stage.chrome.time(at, of: total)
    }

    private func volume(by d: Double) {
        player.volume = Float(min(1, max(0, Double(player.volume) + d)))
        UserDefaults.standard.set(Double(player.volume), forKey: "playerVolume")
        stage.chrome.volume = Double(player.volume)
        stage.chrome.flash("Volume \(Int((Double(player.volume) * 100).rounded()))%")
        pokeChrome()
    }

    /// The media keys' next and previous: a song goes to the next or previous song, anything else to the next file.
    func next() { move(1) }

    func previous() {
        // Back in a song or video that has played a few seconds goes to its start, as every player does.
        if kind.timed, player.currentTime().seconds > 3 { seek(to: 0); return }
        move(-1)
    }

    private func move(_ by: Int) {
        if kind == .audio {
            if let i = playlist.neighbor(by, kinds: [.audio]) { go(to: i) }
        } else {
            step(by)
        }
    }

    func run(_ c: PlayerCommand) {
        switch c {
        case .togglePlay: togglePlay()
        case .seek(let s): seek(by: s); pokeChrome()
        case .step(let n): step(n)
        case .volume(let v): volume(by: v)
        case .toggleFill: toggleFill()
        case .close: close()
        case .info: infoShown.toggle(); infoShown ? refreshInfo() : (stage.info = nil)
        }
    }

    /// Turns a key press into a command. False passes the key on.
    private func handle(_ e: NSEvent) -> Bool {
        let key: PlayerKey
        switch e.keyCode {
        case 49: key = .space
        case 123: key = .left
        case 124: key = .right
        case 125: key = .down
        case 126: key = .up
        case 53: key = .escape
        default:
            guard let ch = e.charactersIgnoringModifiers?.lowercased().first else { return false }
            key = .character(ch)
        }
        var mods: PlayerModifiers = []
        let f = e.modifierFlags
        if f.contains(.command) { mods.insert(.command) }
        if f.contains(.shift) { mods.insert(.shift) }
        if f.contains(.option) { mods.insert(.option) }
        if f.contains(.control) { mods.insert(.control) }
        guard let c = PlayerKeys.command(key, mods, kind: kind) else { return false }
        // Held keys repeat a seek, a step or the volume; never a toggle.
        if e.isARepeat {
            switch c {
            case .seek, .step, .volume: break
            default: return true
            }
        }
        run(c)
        return true
    }

    // MARK: Fill the screen

    /// `f`: fill the screen in place, without macOS's full screen and its slide to another Space.
    private func toggleFill() {
        guard let w = window, let screen = w.screen ?? NSScreen.main else { return }
        if w.filled {
            w.filled = false
            NSApp.presentationOptions = savedOptions
            if let savedFrame { w.setFrame(savedFrame, display: true) }
        } else {
            savedFrame = w.frame
            savedOptions = NSApp.presentationOptions
            w.filled = true
            NSApp.presentationOptions = savedOptions.union([.autoHideDock, .autoHideMenuBar])
            w.setFrame(screen.frame, display: true)
        }
        pokeChrome()
    }

    // MARK: Close

    func close() {
        guard let w = window, w.isVisible else { return }
        leaveCurrent()
        player.replaceCurrentItem(with: nil)
        NowPlaying.detach()
        if w.filled { toggleFill() }
        idleTimer?.invalidate()
        NSCursor.setHiddenUntilMouseMoves(false)
        stage.photo.contents = nil
        stage.info = nil
        infoShown = false
        cache.removeAll()
        cacheOrder.removeAll()
        wants.set([])
        w.orderOut(nil)
        trace("closed")
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        close()
        return false
    }

    // MARK: Resume

    private func loadResumeOnce() {
        guard !resumeLoaded, !resumeLoading else { return }
        resumeLoading = true
        io.async { [weak self] in
            let r = PlayerResume.load(Self.resumeFile)
            DispatchQueue.main.async {
                guard let self else { return }
                // Anything noted before the load finished wins over the file.
                var merged = r
                for (path, e) in self.resume.entries {
                    merged.note(path, kind: .video, position: e.position, duration: e.duration, now: e.savedAt)
                }
                self.resume = merged
                self.resumeLoaded = true
            }
        }
    }
    private var resumeLoading = false

    private func noteResume(save: Bool) {
        guard resumeClock.mayNote, kind == .video, let item = player.currentItem, item.status == .readyToPlay else { return }
        let path = playlist.current
        let before = resume
        resume.note(path, kind: .video, position: player.currentTime().seconds, duration: item.duration.seconds,
                    now: Date().timeIntervalSince1970)
        guard save, resumeLoaded, resume != before else { return }
        let snapshot = resume
        io.async { try? snapshot.save(Self.resumeFile) }
    }

    @objc private func willTerminate() {
        noteResume(save: false)
        guard resumeLoaded else { return }
        let snapshot = resume
        io.sync { try? snapshot.save(Self.resumeFile) }
    }

    // MARK: Info

    private func refreshInfo() {
        let path = playlist.current, k = kind, gen = generation, position = playlist.position
        var lines = [(path as NSString).lastPathComponent, "\(k.rawValue.capitalized), \((path as NSString).pathExtension.lowercased())", position]
        if k.timed, let item = player.currentItem {
            let d = item.duration.seconds
            if d.isFinite { lines.append(PlayerTime.format(d)) }
            let size = item.presentationSize
            if k == .video, size.width > 0 { lines.append("\(Int(size.width)) x \(Int(size.height))") }
        }
        stage.info = lines.joined(separator: "\n")
        io.async { [weak self] in
            var more: [String] = []
            if k == .photo, let px = PhotoDecode.pixelSize(at: URL(fileURLWithPath: path)) { more.append("\(px.width) x \(px.height)") }
            if let bytes = (try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? Int64 {
                more.append(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file))
            }
            more.append((path as NSString).deletingLastPathComponent)
            DispatchQueue.main.async {
                guard let self, self.generation == gen, self.infoShown else { return }
                self.stage.info = (lines + more).joined(separator: "\n")
            }
        }
    }

    // MARK: Chrome

    /// Shows the bar and the window's buttons; they fade out after 1.5 s with no pointer or key.
    private func pokeChrome() {
        stage.setChrome(visible: true)
        idleTimer?.invalidate()
        idleTimer = Timer.scheduledTimer(withTimeInterval: PlayerChromeTiming.idle, repeats: false) { [weak self] _ in
            guard let self, let w = self.window, w.isVisible else { return }
            if self.stage.chrome.isPointerInside { self.pokeChrome(); return }
            self.stage.setChrome(visible: false)
            if w.filled { NSCursor.setHiddenUntilMouseMoves(true) }
        }
    }

    // MARK: Now Playing

    private func updateNowPlaying() {
        guard kind.timed, let item = player.currentItem else { return }
        metadata.elapsed = player.currentTime().seconds
        if item.duration.seconds.isFinite { metadata.duration = item.duration.seconds }
        metadata.rate = Double(player.rate)
        metadata.video = kind == .video
        NowPlaying.publish(metadata)
    }

    // MARK: Window

    private func ensureWindow() -> PlayerWindow {
        if let window { return window }
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let size = NSSize(width: (screen.width * 0.7).rounded(), height: (screen.height * 0.7).rounded())
        let w = PlayerWindow(contentRect: NSRect(origin: .zero, size: size),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                             backing: .buffered, defer: false)
        w.title = "Player"
        w.titleVisibility = .hidden
        w.titlebarAppearsTransparent = true
        w.isMovableByWindowBackground = true
        w.isReleasedWhenClosed = false
        w.acceptsMouseMovedEvents = true
        w.minSize = NSSize(width: 360, height: 240)
        w.delegate = self
        let stage = PlayerStage(frame: NSRect(origin: .zero, size: size))
        stage.video.player = player
        w.contentView = stage
        w.backgroundColor = PlayerPalette.stage
        w.keyHandler = { [weak self] e in self?.handle(e) ?? false }
        w.activity = { [weak self] e in
            guard let self else { return }
            if e.type == .leftMouseDown, e.clickCount == 2, !self.stage.chrome.frame.contains(self.stage.convert(e.locationInWindow, from: nil)) {
                self.toggleFill()
            }
            self.pokeChrome()
        }
        stage.chrome.onToggle = { [weak self] in self?.togglePlay() }
        stage.chrome.onScrub = { [weak self] fraction in
            guard let self, let d = self.player.currentItem?.duration.seconds, d.isFinite else { return }
            self.seek(to: d * fraction)
            self.pokeChrome()
        }
        stage.windowButtons = { [weak w] in
            [.closeButton, .miniaturizeButton, .zoomButton].compactMap { w?.standardWindowButton($0) }
        }
        player.volume = Float(UserDefaults.standard.object(forKey: "playerVolume") as? Double ?? 1)
        stage.chrome.volume = Double(player.volume)
        NotificationCenter.default.addObserver(self, selector: #selector(willTerminate), name: NSApplication.willTerminateNotification, object: nil)
        NotificationCenter.default.addObserver(forName: Appearance.didChange, object: nil, queue: .main) { [weak self, weak w] _ in
            w?.backgroundColor = PlayerPalette.stage
            self?.stage.restyle()
        }
        self.stage = stage
        window = w
        w.center()
        return w
    }

    // MARK: Log

    /// trace.log and the unified log, written off the main thread. Lines hold kinds and times, never file names.
    private func trace(_ line: String) {
        io.async { Trace.log("player: \(line)") }
    }

    private static func ms(since t: DispatchTime) -> Int {
        Int((DispatchTime.now().uptimeNanoseconds - t.uptimeNanoseconds) / 1_000_000)
    }
}

/// How long the bar stays with nothing moving. Not an animation length, so not the theme's.
enum PlayerChromeTiming {
    static let idle: TimeInterval = 1.5
}

// MARK: - Window and stage

final class PlayerWindow: NSWindow {
    var keyHandler: ((NSEvent) -> Bool)?
    var activity: ((NSEvent) -> Void)?
    /// Filling the screen: the frame may cover the menu bar.
    var filled = false

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    // Keys are taken here, before AVPlayerView or the slider can use them, so the player's keys mean the same
    // whatever holds focus inside it.
    override func sendEvent(_ e: NSEvent) {
        switch e.type {
        case .keyDown:
            if keyHandler?(e) == true { return }
        case .mouseMoved, .leftMouseDown, .leftMouseDragged, .rightMouseDown, .scrollWheel:
            activity?(e)
        default: break
        }
        super.sendEvent(e)
    }

    override func performKeyEquivalent(with e: NSEvent) -> Bool {
        if keyHandler?(e) == true { return true }
        return super.performKeyEquivalent(with: e)
    }

    override func constrainFrameRect(_ r: NSRect, to screen: NSScreen?) -> NSRect {
        filled ? r : super.constrainFrameRect(r, to: screen)
    }
}

/// The player's colors, all from the theme: the stage is the palette's `dark` role (black in every palette, so a photo
/// or film is never seen against a light panel), the bar is that dark at the HUD's weight with the `light` role's text,
/// and the scrubber is the accent.
enum PlayerPalette {
    static var stage: NSColor { Chrome.look.color("dark").nsColor }
    static var bar: NSColor { Chrome.look.color("dark").nsColor.withAlphaComponent(0.62) }
    static func text(_ opacity: Double = 1) -> NSColor { Chrome.look.color("light").nsColor.withAlphaComponent(opacity) }
    static var accent: NSColor { Appearance.shared.accentRGB.nsColor }
}

final class PlayerStage: NSView {
    enum Mode { case photo, video, audio }

    let photo = CALayer()
    let video = AVPlayerView()
    let audio = PlayerAudioView()
    let chrome = PlayerChromeBar()
    private let infoBox = PlayerLabelBox()
    private let messageLabel = NSTextField(wrappingLabelWithString: "")
    var windowButtons: () -> [NSButton] = { [] }

    var mode: Mode = .photo {
        didSet {
            video.isHidden = mode != .video
            audio.isHidden = mode != .audio
            photo.isHidden = mode != .photo
        }
    }

    var message: String? {
        didSet {
            messageLabel.stringValue = message ?? ""
            messageLabel.isHidden = message == nil
            needsLayout = true
        }
    }

    var info: String? {
        didSet {
            infoBox.text = info ?? ""
            infoBox.isHidden = info == nil
            needsLayout = true
        }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layerContentsRedrawPolicy = .never
        photo.contentsGravity = .resizeAspect
        photo.actions = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull(), "hidden": NSNull()]
        layer?.addSublayer(photo)
        video.controlsStyle = .none
        video.videoGravity = .resizeAspect
        video.isHidden = true
        if #available(macOS 13.0, *) { video.allowsVideoFrameAnalysis = false }
        audio.isHidden = true
        messageLabel.alignment = .center
        messageLabel.isHidden = true
        infoBox.isHidden = true
        for v in [video, audio, messageLabel, infoBox, chrome] as [NSView] { addSubview(v) }
        restyle()
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    func restyle() {
        layer?.backgroundColor = PlayerPalette.stage.cgColor
        video.layer?.backgroundColor = PlayerPalette.stage.cgColor
        messageLabel.font = Chrome.nsFont(14, .medium)
        messageLabel.textColor = PlayerPalette.text(0.85)
        infoBox.restyle()
        audio.restyle()
        chrome.restyle()
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        photo.frame = bounds
        CATransaction.commit()
        video.frame = bounds
        audio.frame = bounds
        let barW = min(bounds.width - 40, 760), barH = chrome.preferredHeight
        chrome.frame = NSRect(x: ((bounds.width - barW) / 2).rounded(), y: 20, width: barW, height: barH)
        let msgW = min(bounds.width - 80, 520)
        let msgH = messageLabel.sizeThatFits(NSSize(width: msgW, height: .greatestFiniteMagnitude)).height
        messageLabel.frame = NSRect(x: ((bounds.width - msgW) / 2).rounded(), y: ((bounds.height - msgH) / 2).rounded(), width: msgW, height: msgH)
        let info = infoBox.fittingSize(maxWidth: min(bounds.width - 40, 420))
        infoBox.frame = NSRect(x: 20, y: bounds.height - info.height - 44, width: info.width, height: info.height)
    }

    private var chromeVisible = true

    /// Fades the bar, the details and the window's buttons in or out at the theme's panel speed.
    func setChrome(visible: Bool) {
        guard visible != chromeVisible else { return }
        chromeVisible = visible
        let views: [NSView] = [chrome, infoBox] + windowButtons()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = Chrome.duration(visible ? 0.14 : 0.24, visible ? .panelIn : .panelOut)
            for v in views { v.animator().alphaValue = visible ? 1 : 0 }
        }
    }
}

/// A song: its cover, or a quiet note when it has none, and its name and artist under it.
final class PlayerAudioView: NSView {
    private let cover = CALayer()
    private let glyph = NSImageView()
    private let title = NSTextField(labelWithString: "")
    private let artist = NSTextField(labelWithString: "")

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        cover.contentsGravity = .resizeAspect
        cover.masksToBounds = true
        cover.actions = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull()]
        layer?.addSublayer(cover)
        glyph.image = NSImage(systemSymbolName: "music.note", accessibilityDescription: nil)
        glyph.symbolConfiguration = .init(pointSize: 96, weight: .light)
        for f in [title, artist] {
            f.alignment = .center
            f.lineBreakMode = .byTruncatingMiddle
        }
        for v in [glyph, title, artist] as [NSView] { addSubview(v) }
        restyle()
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    func restyle() {
        cover.cornerRadius = Chrome.radius(.overviewTile)
        glyph.contentTintColor = PlayerPalette.text(0.35)
        title.font = Chrome.nsFont(20, .semibold)
        title.textColor = PlayerPalette.text()
        artist.font = Chrome.nsFont(14)
        artist.textColor = PlayerPalette.text(0.6)
    }

    func show(title t: String, artist a: String?, artwork: NSImage?) {
        title.stringValue = t
        artist.stringValue = a ?? ""
        cover.contents = artwork
        cover.isHidden = artwork == nil
        glyph.isHidden = artwork != nil
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let side = min(320, bounds.width - 80, bounds.height - 200).rounded()
        let art = NSRect(x: ((bounds.width - side) / 2).rounded(), y: ((bounds.height - side) / 2 + 40).rounded(), width: max(0, side), height: max(0, side))
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        cover.frame = art
        CATransaction.commit()
        glyph.frame = art
        title.frame = NSRect(x: 40, y: art.minY - 44, width: bounds.width - 80, height: 28)
        artist.frame = NSRect(x: 40, y: art.minY - 68, width: bounds.width - 80, height: 20)
    }
}

/// A block of plain lines on the dark bar color: the details `⌘I` shows.
final class PlayerLabelBox: NSView {
    private let label = NSTextField(wrappingLabelWithString: "")
    var text: String {
        get { label.stringValue }
        set { label.stringValue = newValue }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        label.isSelectable = true
        addSubview(label)
        restyle()
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    func restyle() {
        layer?.backgroundColor = PlayerPalette.bar.cgColor
        layer?.cornerRadius = Chrome.radius(.hudPanel)
        label.font = Chrome.nsFont(12)
        label.textColor = PlayerPalette.text(0.9)
    }

    func fittingSize(maxWidth: CGFloat) -> NSSize {
        let s = label.sizeThatFits(NSSize(width: maxWidth - 28, height: .greatestFiniteMagnitude))
        return NSSize(width: min(maxWidth, s.width + 28).rounded(.up), height: (s.height + 20).rounded(.up))
    }

    override func layout() {
        super.layout()
        label.frame = bounds.insetBy(dx: 14, dy: 10)
    }
}

/// The bar along the bottom: play or pause, the name, where it is in the folder, and for songs and videos the time and
/// a scrubber. It fades after 1.5 s idle and stays while the pointer is on it.
final class PlayerChromeBar: NSView {
    var onToggle: () -> Void = {}
    var onScrub: (Double) -> Void = { _ in }

    private let button = NSButton()
    private let title = NSTextField(labelWithString: "")
    private let where_ = NSTextField(labelWithString: "")
    private let elapsed = NSTextField(labelWithString: "0:00")
    private let total = NSTextField(labelWithString: "0:00")
    private let slider = NSSlider(value: 0, minValue: 0, maxValue: 1, target: nil, action: nil)
    private var kind: MediaKind = .photo
    private var tracking: NSTrackingArea?
    private(set) var isPointerInside = false

    var preferredHeight: CGFloat { kind.timed ? 64 : 40 }

    var playing = false {
        didSet {
            button.image = NSImage(systemSymbolName: playing ? "pause.fill" : "play.fill", accessibilityDescription: playing ? "Pause" : "Play")
        }
    }

    var position = "" { didSet { where_.stringValue = position } }

    var volume = 1.0 {
        didSet { button.toolTip = "Volume \(Int((volume * 100).rounded()))%" }
    }

    /// A short note in place of the folder position ("Volume 60%"), back to the position after a second.
    func flash(_ note: String) {
        where_.stringValue = note
        flashWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.where_.stringValue = self.position
        }
        flashWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: work)
    }
    private var flashWork: DispatchWorkItem?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        button.isBordered = false
        button.imagePosition = .imageOnly
        button.target = self
        button.action = #selector(toggle)
        playing = false
        slider.target = self
        slider.action = #selector(scrub)
        slider.isContinuous = true
        slider.controlSize = .small
        title.lineBreakMode = .byTruncatingMiddle
        where_.alignment = .right
        total.alignment = .right
        for v in [button, title, where_, elapsed, total, slider] as [NSView] { addSubview(v) }
        restyle()
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    func restyle() {
        layer?.backgroundColor = PlayerPalette.bar.cgColor
        layer?.cornerRadius = Chrome.radius(.hudPanel)
        button.contentTintColor = PlayerPalette.text()
        title.font = Chrome.nsFont(13, .medium)
        title.textColor = PlayerPalette.text()
        for f in [where_, elapsed, total] {
            f.font = Chrome.nsFont(11)
            f.textColor = PlayerPalette.text(0.65)
        }
        slider.trackFillColor = PlayerPalette.accent
    }

    func configure(title t: String, kind k: MediaKind, position p: String) {
        kind = k
        title.stringValue = t
        position = p
        for v in [button, elapsed, total, slider] as [NSView] { v.isHidden = !k.timed }
        time(0, of: .nan)
        superview?.needsLayout = true
        needsLayout = true
    }

    func time(_ now: Double, of length: Double) {
        elapsed.stringValue = PlayerTime.format(now)
        total.stringValue = PlayerTime.format(length)
        if length.isFinite, length > 0, !isScrubbing { slider.doubleValue = min(1, max(0, now / length)) }
    }

    private var isScrubbing = false

    @objc private func toggle() { onToggle() }

    @objc private func scrub() {
        isScrubbing = NSApp.currentEvent?.type == .leftMouseDragged
        onScrub(slider.doubleValue)
    }

    override func layout() {
        super.layout()
        let pad: CGFloat = 14
        if kind.timed {
            button.frame = NSRect(x: pad - 4, y: bounds.height - 34, width: 28, height: 28)
            title.frame = NSRect(x: pad + 30, y: bounds.height - 30, width: bounds.width - pad * 2 - 30 - 90, height: 18)
            where_.frame = NSRect(x: bounds.width - pad - 90, y: bounds.height - 30, width: 90, height: 16)
            elapsed.frame = NSRect(x: pad, y: 10, width: 56, height: 16)
            total.frame = NSRect(x: bounds.width - pad - 56, y: 10, width: 56, height: 16)
            slider.frame = NSRect(x: pad + 60, y: 8, width: bounds.width - pad * 2 - 120, height: 20)
        } else {
            title.frame = NSRect(x: pad, y: (bounds.height - 18) / 2, width: bounds.width - pad * 2 - 90, height: 18)
            where_.frame = NSRect(x: bounds.width - pad - 90, y: (bounds.height - 16) / 2, width: 90, height: 16)
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let t = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(t)
        tracking = t
    }

    override func mouseEntered(with event: NSEvent) { isPointerInside = true }
    override func mouseExited(with event: NSEvent) { isPointerInside = false; isScrubbing = false }
}

// MARK: - Now Playing

/// Control Center, the media keys and AirPods' controls, only while a song or video is loaded. Closing the player or
/// showing a photo lets them go back to whatever played before.
enum NowPlaying {
    struct Info {
        var title = ""
        var artist: String?
        var album: String?
        var artwork: NSImage?
        var duration = Double.nan
        var elapsed = 0.0
        var rate = 0.0
        var video = false
    }

    private static var attached = false

    static func attach(_ c: PlayerController) {
        guard !attached else { return }
        attached = true
        let cc = MPRemoteCommandCenter.shared()
        cc.playCommand.addTarget { [weak c] _ in
            guard let c else { return .commandFailed }
            if !c.isPlaying { c.togglePlay() }
            return .success
        }
        cc.pauseCommand.addTarget { [weak c] _ in
            guard let c else { return .commandFailed }
            if c.isPlaying { c.togglePlay() }
            return .success
        }
        cc.togglePlayPauseCommand.addTarget { [weak c] _ in c?.togglePlay(); return .success }
        cc.nextTrackCommand.addTarget { [weak c] _ in c?.next(); return .success }
        cc.previousTrackCommand.addTarget { [weak c] _ in c?.previous(); return .success }
        cc.changePlaybackPositionCommand.addTarget { [weak c] e in
            guard let e = e as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            c?.seek(to: e.positionTime)
            return .success
        }
        for cmd in commands { cmd.isEnabled = true }
    }

    private static var commands: [MPRemoteCommand] {
        let cc = MPRemoteCommandCenter.shared()
        return [cc.playCommand, cc.pauseCommand, cc.togglePlayPauseCommand, cc.nextTrackCommand, cc.previousTrackCommand,
                cc.changePlaybackPositionCommand]
    }

    static func detach() {
        guard attached else { return }
        attached = false
        for cmd in commands {
            cmd.removeTarget(nil)
            cmd.isEnabled = false
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        MPNowPlayingInfoCenter.default().playbackState = .stopped
    }

    static func publish(_ i: Info) {
        guard attached else { return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: i.title,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: i.elapsed.isFinite ? i.elapsed : 0,
            MPNowPlayingInfoPropertyPlaybackRate: i.rate,
            MPNowPlayingInfoPropertyMediaType: (i.video ? MPNowPlayingInfoMediaType.video : .audio).rawValue,
        ]
        if i.duration.isFinite { info[MPMediaItemPropertyPlaybackDuration] = i.duration }
        if let a = i.artist, !a.isEmpty { info[MPMediaItemPropertyArtist] = a }
        if let a = i.album, !a.isEmpty { info[MPMediaItemPropertyAlbumTitle] = a }
        if let art = i.artwork {
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: art.size) { _ in art }
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        MPNowPlayingInfoCenter.default().playbackState = i.rate != 0 ? .playing : .paused
    }
}

extension PlayerController {
    var isPlaying: Bool { player.rate != 0 }
}
