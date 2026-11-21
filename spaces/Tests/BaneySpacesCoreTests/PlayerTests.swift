@testable import BaneySpacesCore
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest

/// The player's pure rules (spec/player.md): which files it opens, the folder playlist, the keys, where a long video
/// picks up again, and how fast a photo decodes at screen size.
final class PlayerMediaTests: XCTestCase {
    func testEachAskedForTypeHasItsKind() {
        for e in ["mp3", "m4a", "flac", "wav", "aac"] { XCTAssertEqual(PlayerMedia.kind(ofExtension: e), .audio, e) }
        for e in ["mp4", "mov", "m4v", "mkv"] { XCTAssertEqual(PlayerMedia.kind(ofExtension: e), .video, e) }
        for e in ["jpg", "jpeg", "png", "heic", "gif", "webp", "dng", "cr2", "cr3", "nef", "arw", "raf"] {
            XCTAssertEqual(PlayerMedia.kind(ofExtension: e), .photo, e)
        }
    }

    func testCaseAndPathsDontMatterAndOtherFilesAreNotMedia() {
        XCTAssertEqual(PlayerMedia.kind(of: "/Users/me/Movies/Trip.MOV"), .video)
        XCTAssertEqual(PlayerMedia.kind(of: "IMG_0001.JPG"), .photo)
        XCTAssertNil(PlayerMedia.kind(of: "notes.txt"))
        XCTAssertNil(PlayerMedia.kind(of: "/Users/me/mp3"))
        XCTAssertNil(PlayerMedia.kind(of: "archive.mp3.zip"))
    }

    func testOnlyPhotosHaveNoTimeLine() {
        XCTAssertTrue(MediaKind.audio.timed)
        XCTAssertTrue(MediaKind.video.timed)
        XCTAssertFalse(MediaKind.photo.timed)
    }

    /// AVFoundation opens few mkv files: the player says so in words, never a black window.
    func testAnMkvItCantPlaySaysWhy() {
        XCTAssertTrue(PlayerMedia.cannotPlay("/a/b.mkv").contains("AVFoundation opens only some mkv files"))
        XCTAssertEqual(PlayerMedia.cannotPlay("/a/b.mp4"), "macOS can't play this .mp4 file.")
    }

    func testTimesReadAsAPlayerShowsThem() {
        XCTAssertEqual(PlayerTime.format(0), "0:00")
        XCTAssertEqual(PlayerTime.format(5.9), "0:05")
        XCTAssertEqual(PlayerTime.format(754), "12:34")
        XCTAssertEqual(PlayerTime.format(3723), "1:02:03")
        XCTAssertEqual(PlayerTime.format(.nan), "0:00")
        XCTAssertEqual(PlayerTime.format(-3), "0:00")
    }
}

final class PlayerPlaylistTests: XCTestCase {
    let names = ["track10.mp3", "Track2.mp3", "track1.mp3", ".hidden.mp3", "notes.txt", "cover.JPG", "._track1.mp3",
                 "IMG_10.heic", "IMG_0009.heic", "clip.mov"]

    func testTheFolderInFinderNameOrderWithOnlyMediaAndNoHiddenFiles() {
        let list = PlayerPlaylist.make(opened: "/m/Track2.mp3", names: names)
        XCTAssertEqual(list.items.map { ($0 as NSString).lastPathComponent },
                       ["clip.mov", "cover.JPG", "IMG_0009.heic", "IMG_10.heic", "track1.mp3", "Track2.mp3", "track10.mp3"])
        XCTAssertEqual(list.current, "/m/Track2.mp3")
        XCTAssertEqual(list.position, "6 of 7")
    }

    func testNumbersSortByValue() {
        XCTAssertTrue(NameOrder.less("a2", "a10"))
        XCTAssertTrue(NameOrder.less("IMG_0009", "IMG_10"))
        XCTAssertFalse(NameOrder.less("a10", "a2"))
        XCTAssertTrue(NameOrder.less("Photo", "photo 1"))
        // Equal but for case: a fixed order, so two machines list the same folder alike.
        XCTAssertTrue(NameOrder.less("A.jpg", "a.jpg"))
        XCTAssertFalse(NameOrder.less("a.jpg", "A.jpg"))
    }

    func testAHiddenFileOpenedByPathIsStillInIt() {
        let list = PlayerPlaylist.make(opened: "/m/.hidden.mp3", names: names)
        XCTAssertEqual(list.current, "/m/.hidden.mp3")
        XCTAssertTrue(list.items.contains("/m/track1.mp3"))
    }

    func testAFileTheListingMissedIsStillInIt() {
        let list = PlayerPlaylist.make(opened: "/m/new.mp4", names: ["a.mp4"])
        XCTAssertEqual(list.items, ["/m/a.mp4", "/m/new.mp4"])
        XCTAssertEqual(list.index, 1)
    }

    func testNeighborsStopAtTheEndsAndCanSkipOtherKinds() {
        var list = PlayerPlaylist.make(opened: "/m/track1.mp3", names: names)
        XCTAssertEqual(list.neighbor(1).map { list.items[$0] }, "/m/Track2.mp3")
        XCTAssertEqual(list.neighbor(-1).map { list.items[$0] }, "/m/IMG_10.heic")
        // A song that ends goes to the previous or next song, past the photos.
        list.index = list.items.firstIndex(of: "/m/track10.mp3")!
        XCTAssertNil(list.neighbor(1))
        XCTAssertNil(list.neighbor(1, kinds: [.audio]))
        list.index = list.items.firstIndex(of: "/m/track1.mp3")!
        XCTAssertNil(list.neighbor(-1, kinds: [.audio]))
        XCTAssertEqual(list.neighbor(-2, kinds: [.photo]).map { list.items[$0] }, "/m/IMG_0009.heic")
        XCTAssertEqual(list.neighbor(0), list.index)
    }

    func testOnlyAdjacentPhotosArePrefetchedNextFirst() {
        var list = PlayerPlaylist.make(opened: "/m/IMG_0009.heic", names: names)
        XCTAssertEqual(list.prefetch, ["/m/IMG_10.heic", "/m/cover.JPG"])
        list.index = list.items.firstIndex(of: "/m/IMG_10.heic")!
        XCTAssertEqual(list.prefetch, ["/m/IMG_0009.heic"], "a song next to it is not decoded as a photo")
        XCTAssertEqual(PlayerPlaylist(single: "/m/a.jpg").prefetch, [])
    }
}

final class PlayerKeysTests: XCTestCase {
    func cmd(_ k: PlayerKey, _ m: PlayerModifiers = [], _ kind: MediaKind) -> PlayerCommand? {
        PlayerKeys.command(k, m, kind: kind)
    }

    func testTheAskedForKeys() {
        for kind in [MediaKind.audio, .video] {
            XCTAssertEqual(cmd(.space, [], kind), .togglePlay)
            XCTAssertEqual(cmd(.left, [], kind), .seek(-5))
            XCTAssertEqual(cmd(.right, [], kind), .seek(5))
            XCTAssertEqual(cmd(.right, .shift, kind), .seek(30))
            XCTAssertEqual(cmd(.up, [], kind), .volume(0.1))
            XCTAssertEqual(cmd(.down, [], kind), .volume(-0.1))
        }
        XCTAssertEqual(cmd(.left, [], .photo), .step(-1))
        XCTAssertEqual(cmd(.right, [], .photo), .step(1))
        XCTAssertEqual(cmd(.right, .shift, .photo), .step(1))
        for kind in MediaKind.allCases {
            XCTAssertEqual(cmd(.character("f"), [], kind), .toggleFill)
            XCTAssertEqual(cmd(.escape, [], kind), .close)
            XCTAssertEqual(cmd(.character("i"), .command, kind), .info)
            XCTAssertEqual(cmd(.character("w"), .command, kind), .close)
            XCTAssertEqual(cmd(.right, .command, kind), .step(1))
            XCTAssertEqual(cmd(.left, .command, kind), .step(-1))
        }
    }

    func testAPhotoHasNoPlayOrVolume() {
        XCTAssertNil(cmd(.space, [], .photo))
        XCTAssertNil(cmd(.up, [], .photo))
        XCTAssertNil(cmd(.down, [], .photo))
    }

    /// Everything else passes on: ⌘Q, ⌘Tab, Polycarp's own ⌃ and ⌥ keys, a plain letter.
    func testOtherKeysPassOn() {
        XCTAssertNil(cmd(.character("q"), .command, .video))
        XCTAssertNil(cmd(.character("f"), .command, .video))
        XCTAssertNil(cmd(.right, .control, .video))
        XCTAssertNil(cmd(.right, .option, .photo))
        XCTAssertNil(cmd(.space, [.command, .shift], .audio))
        XCTAssertNil(cmd(.character("i"), [], .video))
        XCTAssertNil(cmd(.character("x"), [], .photo))
    }
}

final class PlayerResumeTests: XCTestCase {
    let long = 3600.0

    func testOnlyVideosOverTenMinutesAreRemembered() {
        var r = PlayerResume()
        r.note("/v/short.mp4", kind: .video, position: 300, duration: 600, now: 1)
        r.note("/v/song.mp3", kind: .audio, position: 300, duration: long, now: 1)
        r.note("/v/film.mp4", kind: .video, position: 1234, duration: long, now: 1)
        XCTAssertEqual(Array(r.entries.keys), ["/v/film.mp4"])
        XCTAssertEqual(r.position(for: "/v/film.mp4", duration: long), 1234)
        XCTAssertTrue(PlayerResume.remembers(.video, duration: 601))
        XCTAssertFalse(PlayerResume.remembers(.video, duration: 600))
        XCTAssertFalse(PlayerResume.remembers(.video, duration: .nan))
    }

    func testNearTheStartOrTheEndLeavesNothing() {
        var r = PlayerResume()
        r.note("/v/a.mp4", kind: .video, position: 1234, duration: long, now: 1)
        r.note("/v/a.mp4", kind: .video, position: long - 10, duration: long, now: 2)
        XCTAssertNil(r.position(for: "/v/a.mp4", duration: long), "watched to the end: forgotten")
        r.note("/v/b.mp4", kind: .video, position: 4, duration: long, now: 1)
        XCTAssertNil(r.position(for: "/v/b.mp4", duration: long))
    }

    func testAFileOfAnotherLengthIsADifferentFile() {
        var r = PlayerResume()
        r.note("/v/a.mp4", kind: .video, position: 900, duration: long, now: 1)
        XCTAssertNil(r.position(for: "/v/a.mp4", duration: long + 60))
        XCTAssertEqual(r.position(for: "/v/a.mp4", duration: long + 0.5), 900)
        XCTAssertTrue(r.has("/v/a.mp4"))
    }

    func testTheOldestGoPastTheLimit() {
        var r = PlayerResume()
        for i in 0...PlayerResume.limit { r.note("/v/\(i).mp4", kind: .video, position: 900, duration: long, now: Double(i)) }
        XCTAssertEqual(r.entries.count, PlayerResume.limit)
        XCTAssertNil(r.entries["/v/0.mp4"])
        XCTAssertNotNil(r.entries["/v/\(PlayerResume.limit).mp4"])
    }

    func testItSurvivesASaveAndABadFileStartsEmpty() throws {
        var r = PlayerResume()
        r.note("/v/a.mp4", kind: .video, position: 900, duration: long, now: 5)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("player-resume-\(UUID().uuidString)/r.json")
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        try r.save(url)
        XCTAssertEqual(PlayerResume.load(url), r)
        try Data("not json".utf8).write(to: url)
        XCTAssertEqual(PlayerResume.load(url), PlayerResume())
        XCTAssertEqual(PlayerResume.load(url.appendingPathExtension("missing")), PlayerResume())
    }
}

final class PlayerWiringTests: XCTestCase {
    /// `play` opens a file on this Mac: another machine's token never gets it.
    func testPlayIsLocalOnly() throws {
        XCTAssertFalse(Remote.allows(Wire.Request(op: .play, target: "/tmp/a.mp4")))
        let r = try JSONDecoder().decode(Wire.Request.self, from: Data(#"{"op":"play","target":"/a.mp4"}"#.utf8))
        XCTAssertEqual(r.op, .play)
    }

    /// Every extension the player opens is in a document type, and every document type is an Alternate handler: the
    /// player shows up in Open With and never takes a default.
    func testTheAppOpensEveryTypeAsAnAlternateOnly() throws {
        let data = try Data(contentsOf: Repo.root.appendingPathComponent("Resources/Info.plist"))
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        let docs = try XCTUnwrap(plist["CFBundleDocumentTypes"] as? [[String: Any]])
        XCTAssertFalse(docs.isEmpty)
        var claimed: [UTType] = []
        for d in docs {
            XCTAssertEqual(d["LSHandlerRank"] as? String, "Alternate", "\(d["CFBundleTypeName"] ?? "?")")
            XCTAssertEqual(d["CFBundleTypeRole"] as? String, "Viewer")
            claimed += (d["LSItemContentTypes"] as? [String] ?? []).compactMap { UTType($0) }
        }
        for ext in PlayerMedia.audio.union(PlayerMedia.video).union(PlayerMedia.photo) {
            let t = UTType(filenameExtension: ext)
            if ext == "mkv" { continue } // declared by the plist itself (UTImportedTypeDeclarations)
            guard let t, !t.isDynamic else { continue } // a raw extension this macOS doesn't know
            XCTAssertTrue(claimed.contains { t.conforms(to: $0) }, "\(ext) (\(t.identifier)) has no document type")
        }
    }

    /// The CLI checks the path and the kind itself, so the app never touches the disk on its main thread for it.
    func testTheCommandSendsAnAbsolutePathItChecked() throws {
        let cli = try Repo.code("Sources/baneyspaces-cli/main.swift")
        let play = try XCTUnwrap(SourceText.between(#"case "play":"#, #"case "send":"#, in: cli))
        XCTAssertTrue(play.contains("standardizedFileURL"))
        XCTAssertTrue(play.contains("PlayerMedia.kind"))
        XCTAssertTrue(play.contains("op: .play"))
    }
}

/// R-P4: a photo shows within 50 ms on a warm app. The decode is most of that, so it has its own budget: a
/// 4000 x 3000 JPEG (a 12-megapixel camera photo) decoded for a 3024 x 1964 Retina laptop screen.
///
/// The budget is on the best of nine runs, which measures the path and not how busy the Mac is: the path it replaces
/// (`CGImageSourceCreateThumbnailAtIndex` at 3024 px) took 195 to 590 ms at best on the same Mac, so going back to it fails
/// by a wide margin even on a loaded machine. The median is printed for the record.
final class PhotoDecodeSpeedTests: XCTestCase {
    static let budgetMs = 45.0
    static let screen = CGSize(width: 3024, height: 1964)

    static func pixels(_ width: Int, _ height: Int, _ fill: (Int, Int, UnsafeMutablePointer<UInt8>) -> Void) throws -> CGImage {
        let ctx = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                          space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        let px = ctx.data!.bindMemory(to: UInt8.self, capacity: ctx.bytesPerRow * height)
        for y in 0..<height { for x in 0..<width { fill(x, y, px + y * ctx.bytesPerRow + x * 4) } }
        return try XCTUnwrap(ctx.makeImage())
    }

    static func write(_ image: CGImage, type: UTType, orientation: Int = 1, quality: Double = 0.85) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("player-\(UUID().uuidString).\(type.preferredFilenameExtension ?? "img")")
        let dest = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality,
                                                 kCGImagePropertyOrientation: orientation] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        return url
    }

    /// Detail everywhere, as a photo has, so the JPEG is a camera photo's size (about 2.7 MB) and not a flat field.
    static func makeJPEG(width: Int, height: Int) throws -> URL {
        var seed: UInt32 = 2026
        let image = try pixels(width, height) { x, y, p in
            seed = seed &* 1_664_525 &+ 1_013_904_223
            let n = UInt8(truncatingIfNeeded: seed >> 29)
            p[0] = UInt8(truncatingIfNeeded: x / 16) &+ n
            p[1] = UInt8(truncatingIfNeeded: y / 12) &+ n
            p[2] = UInt8(truncatingIfNeeded: (x + y) / 28) &+ n
        }
        return try write(image, type: .jpeg)
    }

    func testAScreenSizedDecodeOfATwelveMegapixelJPEGIsInBudget() throws {
        let url = try Self.makeJPEG(width: 4000, height: 3000)
        defer { try? FileManager.default.removeItem(at: url) }
        let bytes = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        XCTAssertGreaterThan(bytes, 1_500_000, "the test photo has real detail")

        let first = try XCTUnwrap(PhotoDecode.image(at: url, screen: Self.screen))
        let shown = PhotoDecode.fit(CGSize(width: 4000, height: 3000), in: Self.screen)
        XCTAssertGreaterThanOrEqual(CGFloat(first.width), shown.width.rounded(.down), "never decoded smaller than it is drawn")
        XCTAssertGreaterThanOrEqual(CGFloat(first.height), shown.height.rounded(.down))
        // Decoded into Polycarp's own bitmap, not left for Core Animation to decode on the main thread.
        XCTAssertEqual(first.alphaInfo, .noneSkipLast)
        let size = try XCTUnwrap(PhotoDecode.pixelSize(at: url))
        XCTAssertEqual(size.width, 4000)
        XCTAssertEqual(size.height, 3000)
        XCTAssertEqual(PhotoDecode.frameCount(at: url), 1)

        var times: [Double] = []
        for _ in 0..<9 {
            let t = DispatchTime.now().uptimeNanoseconds
            XCTAssertNotNil(PhotoDecode.image(at: url, screen: Self.screen))
            times.append(Double(DispatchTime.now().uptimeNanoseconds - t) / 1_000_000)
        }
        let sorted = times.sorted()
        print("photo decode 4000x3000 for a 3024x1964 screen: best \(String(format: "%.1f", sorted[0])) ms, median \(String(format: "%.1f", sorted[sorted.count / 2])) ms")
        XCTAssertLessThan(sorted[0], Self.budgetMs, "a screen-sized decode of a 12 MP JPEG must stay under \(Self.budgetMs) ms")
    }

    func testTheDecodeIsSubsampledOnlyWhileItStillCoversTheScreen() {
        // A Retina laptop needs the whole 12 MP photo; a 1080p screen needs half.
        XCTAssertEqual(PhotoDecode.subsample(width: 4000, height: 3000, screen: Self.screen), 1)
        XCTAssertEqual(PhotoDecode.subsample(width: 4000, height: 3000, screen: CGSize(width: 1920, height: 1080)), 2)
        XCTAssertEqual(PhotoDecode.subsample(width: 8000, height: 6000, screen: Self.screen), 2)
        XCTAssertEqual(PhotoDecode.subsample(width: 16000, height: 12000, screen: CGSize(width: 1920, height: 1080)), 8)
        // A portrait iPhone photo (stored landscape, orientation 6) fits by its height.
        XCTAssertEqual(PhotoDecode.subsample(width: 4032, height: 3024, orientation: 6, screen: Self.screen), 2)
        XCTAssertEqual(PhotoDecode.subsample(width: 400, height: 300, screen: Self.screen), 1, "a small photo is never shrunk")
    }

    /// Every EXIF orientation comes out exactly as ImageIO's own transform turns it.
    func testEveryOrientationMatchesImageIO() throws {
        let colors: [[UInt8]] = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]]
        let image = try Self.pixels(3, 2) { x, y, p in
            let c = colors[y * 3 + x]
            p[0] = c[0]; p[1] = c[1]; p[2] = c[2]; p[3] = 255
        }
        func rgba(_ i: CGImage) throws -> [UInt8] {
            let ctx = try XCTUnwrap(CGContext(data: nil, width: i.width, height: i.height, bitsPerComponent: 8, bytesPerRow: i.width * 4,
                                              space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            ctx.draw(i, in: CGRect(x: 0, y: 0, width: i.width, height: i.height))
            return Array(UnsafeBufferPointer(start: ctx.data!.bindMemory(to: UInt8.self, capacity: i.width * i.height * 4), count: i.width * i.height * 4))
        }
        for o in 1...8 {
            let url = try Self.write(image, type: .tiff, orientation: o)
            defer { try? FileManager.default.removeItem(at: url) }
            let ours = try XCTUnwrap(PhotoDecode.image(at: url, screen: Self.screen))
            let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
            let theirs = try XCTUnwrap(PhotoDecode.thumbnail(source, maxPixels: 3))
            XCTAssertEqual(ours.width, theirs.width, "orientation \(o)")
            XCTAssertEqual(ours.height, theirs.height, "orientation \(o)")
            XCTAssertEqual(try rgba(ours), try rgba(theirs), "orientation \(o)")
        }
    }

    func testAPhotoThatIsNotThereIsNil() {
        XCTAssertNil(PhotoDecode.image(at: URL(fileURLWithPath: "/nonexistent/a.jpg"), screen: Self.screen))
        XCTAssertNil(PhotoDecode.pixelSize(at: URL(fileURLWithPath: "/nonexistent/a.jpg")))
    }
}

/// Review of #576: the three ways the player broke what it claims.
final class PlayerReviewFixTests: XCTestCase {
    let player = "Sources/BaneySpaces/Player.swift"

    /// first-F1: watching video A to 900 s, then opening B with a saved place, noted B at 0 before its seek finished,
    /// which deleted B's place; Esc before the next tick lost it for good.
    func testANewVideoKeepsItsSavedPlaceWhileTheSeekToItRuns() throws {
        var store = PlayerResume()
        store.note("/v/B.mp4", kind: .video, position: 1234, duration: 3600, now: 1)
        var clock = PlayerResumeClock()
        XCTAssertTrue(clock.tick(900), "A noted at 900")
        clock.newItem()
        clock.seekStarted()
        // B is ready; the seek to 1234 hasn't finished, so its time still reads 0.
        if clock.tick(0) { store.note("/v/B.mp4", kind: .video, position: 0, duration: 3600, now: 2) }
        // Esc before the seek finishes.
        if clock.mayNote { store.note("/v/B.mp4", kind: .video, position: 0, duration: 3600, now: 3) }
        XCTAssertEqual(store.position(for: "/v/B.mp4", duration: 3600), 1234)
        clock.seekEnded(at: 1234)
        XCTAssertTrue(clock.mayNote)
        XCTAssertFalse(clock.tick(1240), "not 15 s since the place it landed on")
        XCTAssertTrue(clock.tick(1250))

        let code = try Repo.code(player)
        XCTAssertTrue(try XCTUnwrap(SourceText.block(after: "private func showTimed(", in: code)).contains("resumeClock.newItem()"))
        XCTAssertTrue(try XCTUnwrap(SourceText.block(after: "private func noteResume(", in: code)).contains("resumeClock.mayNote"))
        XCTAssertTrue(try XCTUnwrap(SourceText.block(after: "private func statusChanged(", in: code)).contains("resumeClock.seekStarted()"))
    }

    /// second-F5: a held arrow queued a full decode per photo passed, and every one ran before the photo landed on.
    func testDecodesForPhotosAlreadyPassedAreSkipped() throws {
        let wants = PhotoWants()
        let queue = DispatchQueue(label: "test.decode")
        queue.suspend()
        var ran: [Int] = []
        for i in 0..<60 {
            wants.set([String(i), String(i + 1), String(i - 1)])
            queue.async { if wants.contains(String(i)) { ran.append(i) } }
        }
        queue.resume()
        queue.sync {}
        XCTAssertEqual(ran, [58, 59], "only the photo landed on and the neighbor still wanted are decoded, not 60")

        // The app checks before it decodes, not after.
        let decode = try XCTUnwrap(SourceText.block(after: "private func decode(", in: try Repo.code(player)))
        let check = try XCTUnwrap(decode.range(of: "wants.contains(k)"))
        let work = try XCTUnwrap(decode.range(of: "PhotoDecode.image("))
        XCTAssertLessThan(check.lowerBound, work.lowerBound)
    }

    /// second-F6: a polycarp:// link that launched the app reached `application(_:open:)`, which dropped it.
    func testALinkThatLaunchesPolycarpIsRunNotDropped() throws {
        let urls = [URL(string: "polycarp://switch/2")!, URL(fileURLWithPath: "/p/a.txt"), URL(fileURLWithPath: "/p/b.jpg"),
                    URL(string: "https://example.com")!, URL(string: "baneyspaces://restore")!]
        let r = PlayerOpen.route(urls)
        XCTAssertEqual(r.media?.path, "/p/b.jpg")
        XCTAssertEqual(r.links.map(\.absoluteString), ["polycarp://switch/2", "baneyspaces://restore"])

        let open = try XCTUnwrap(SourceText.block(after: "func application(_ sender: NSApplication, open urls: [URL])", in: try Repo.code(player)))
        XCTAssertTrue(open.contains("runURL("), "links go to the code the app's link handler runs")
        let handler = try XCTUnwrap(SourceText.block(after: "@objc private func handleURL(", in: try Repo.code("Sources/BaneySpaces/AppDelegate.swift")))
        XCTAssertTrue(handler.contains("runURL("))
    }
}
