import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
import zlib
@testable import BaneySpacesCore

/// The paper: one value for what lies behind the desktop, the new tab page and the idle screen (Paper.swift). The
/// desktop is `ThemeWallpaperTests.FakeDesktop`; no test reads or sets the real one, and none reaches the network.
final class PaperTests: XCTestCase {
    private var dir: URL!
    private var file: String { dir.appendingPathComponent("surfaces.json").path }
    private var store: PaperStore { PaperStore.beside(surfacesFile: file) }

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("polycarp-paper-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    /// A picture of `width` by `height` pixels. `noise` fills it with random pixels, which JPEG can't squeeze, so it is
    /// as hard to fit under the new tab's cap as a picture gets.
    private func picture(width: Int, height: Int, type: UTType = .png, noise: Bool = false, seed: UInt8 = 1) throws -> Data {
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space,
                                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        if noise, let p = ctx.data?.assumingMemoryBound(to: UInt64.self) {
            // xorshift64: fast, and as hard on JPEG as true noise.
            var x: UInt64 = 0x9E37_79B9_7F4A_7C15
            for i in 0..<(width * height / 2) { x ^= x << 13; x ^= x >> 7; x ^= x << 17; p[i] = x }
        } else {
            ctx.setFillColor(CGColor(colorSpace: space, components: [Double(seed) / 255, 0.4, 0.6, 1])!)
            ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
        let image = try XCTUnwrap(ctx.makeImage())
        let out = NSMutableData()
        let dest = try XCTUnwrap(CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(dest, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        return out as Data
    }

    private func write(_ data: Data, _ name: String) throws -> String {
        let u = dir.appendingPathComponent(name)
        try data.write(to: u)
        return u.path
    }

    private func surfaces() throws -> Surfaces {
        guard case .document(let d) = SurfacesFile.load(path: file) else { return Surfaces.defaults }
        return d.surfaces
    }

    private func tree() -> SurfaceValue? {
        guard case .document(let d) = SurfacesFile.load(path: file) else { return nil }
        return d.tree
    }

    // MARK: What `paper set` takes

    func testWhatIsAColorASceneAURLOrAPicturePath() {
        func parsed(_ s: String) -> PaperInput? { try? PaperInput.parse(s, cwd: "/work", home: "/Users/me").get() }
        XCTAssertEqual(parsed("#2b2e26"), .color(RGB(hex: "#2B2E26")!))
        XCTAssertEqual(parsed(" #2B2E26 "), .color(RGB(hex: "#2B2E26")!), "spaces around it are dropped")
        XCTAssertEqual(parsed("olive"), .scene(.olive))
        XCTAssertEqual(parsed("Field"), .scene(.field), "a scene name in any case")
        XCTAssertEqual(parsed("solid"), .scene(.solid))
        XCTAssertEqual(parsed("https://example.com/sunset.jpg"), .url(URL(string: "https://example.com/sunset.jpg")!))
        XCTAssertEqual(parsed("~/Pictures/sunset.heic"), .file("/Users/me/Pictures/sunset.heic"))
        XCTAssertEqual(parsed("sunset.JPG"), .file("/work/sunset.JPG"), "a relative path starts where the command runs")
        XCTAssertEqual(parsed("../a/b.webp"), .file("/a/b.webp"))
        XCTAssertEqual(parsed("/tmp/x.jpeg"), .file("/tmp/x.jpeg"))
        XCTAssertEqual(parsed("/tmp/x.png"), .file("/tmp/x.png"))

        for bad in ["", "  ", "#12345", "#1234567", "#ggg000", "http://example.com/a.png", "ftp://example.com/a.png",
                    "data:image/png;base64,AAAA", "notes.txt", "sunset", "https://"] {
            guard case .failure(let f) = PaperInput.parse(bad, cwd: "/work") else { XCTFail("\"\(bad)\" is not a paper"); continue }
            XCTAssertEqual(f.code, "invalid_paper", bad)
            XCTAssertFalse(f.message.isEmpty, bad)
        }
    }

    func testAPaperValueReadsBackAndAnythingElseIsAnErrorWithItsPath() throws {
        for id in ["#2B2E26", "field", "olive", "water", "parchment", "solid", "picture:paper-0123456789abcdef.jpg"] {
            XCTAssertEqual(Paper(id: id)?.id, id)
        }
        XCTAssertNil(Paper(id: ""), "empty is no paper")
        XCTAssertEqual(Paper(id: "#2b2e26")?.id, "#2B2E26")
        for bad in ["picture:../../etc/passwd", "picture:sunset.jpg", "image:dawn.png", "blue", "#12"] {
            XCTAssertNil(Paper(id: bad), bad)
            for path in ["paper", "desktop.paper", "newtab.paper", "idle.paper"] {
                let keys = path.split(separator: ".").map(String.init)
                guard case .failure(let e) = Surfaces.check(SurfaceValue.object([:]).setting(keys, to: .string(bad))) else {
                    XCTFail("\(path) = \(bad) passed"); continue
                }
                XCTAssertEqual(e.issues.map(\.path), [path])
            }
        }
        let schema = Surfaces.schema
        XCTAssertNotNil(schema.at(["properties", "paper", "anyOf"]), "the published schema has paper")
        XCTAssertEqual(schema.at(["properties", "newtab", "properties", "paper", "default"]), .string(""))
    }

    // MARK: Each place and its fallback

    func testUnsetMeansNoPaperAnywhere() {
        let d = Surfaces.defaults
        XCTAssertNil(d.paper)
        for p in PaperPlace.allCases { XCTAssertNil(d.paper(on: p), p.rawValue) }
        XCTAssertNil(NewTabHost.answer(Data(#"{"op":"page"}"#.utf8), source: NewTabHost.Source(surfaces: { d }, papers: store))
            .range(of: Data("paper".utf8)), "no paper, no key in the reply")
    }

    func testEachPlaceTakesItsOwnPaperElseTheSharedOne() throws {
        let doc = try SurfaceValue.parse(Data(##"{"paper":"olive","newtab":{"paper":"#112233"},"idle":{"paper":""}}"##.utf8)).get()
        let s = try Surfaces.check(doc).get().surfaces
        XCTAssertEqual(s.paper(on: .desktop), .scene(.olive))
        XCTAssertEqual(s.paper(on: .newtab), .color(RGB(hex: "#112233")!))
        XCTAssertEqual(s.paper(on: .idle), .scene(.olive), "empty follows paper")
        let own = try Surfaces.check(try SurfaceValue.parse(Data(#"{"desktop":{"paper":"water"}}"#.utf8)).get()).get().surfaces
        XCTAssertEqual(own.paper(on: .desktop), .scene(.water))
        XCTAssertNil(own.paper(on: .newtab))
        XCTAssertNil(own.paper(on: .idle))
    }

    func testOnTakesPlacesJoinedWithCommasOrAll() {
        XCTAssertEqual(PaperPlace.parse("all"), Set(PaperPlace.allCases))
        XCTAssertEqual(PaperPlace.parse("desktop,newtab"), [.desktop, .newtab])
        XCTAssertEqual(PaperPlace.parse("IDLE"), [.idle])
        XCTAssertNil(PaperPlace.parse("desktop,dock"))
        XCTAssertNil(PaperPlace.parse(""))
    }

    // MARK: Set, reset and the pictures kept

    func testSettingAPictureCopiesItUnderANameItMakesAndEveryPlaceShowsIt() throws {
        let path = try write(try picture(width: 64, height: 40, type: .jpeg), "My Sunset (1).jpg")
        let out = try PaperOps.set(path, on: Set(PaperPlace.allCases), file: file, cwd: "/").get()
        let value = try XCTUnwrap(out.at(["paper", "value"])?.string)
        XCTAssertTrue(SurfaceCheck.matches(String(value.dropFirst(8)), Paper.picturePattern), value)
        XCTAssertEqual(out.at(["desktop", "from"]), .string("paper"))
        let s = try surfaces()
        guard case .picture(let name)? = s.paper else { return XCTFail("paper is a picture") }
        XCTAssertTrue(name.hasSuffix(".jpg"))
        XCTAssertEqual(FileManager.default.contents(atPath: store.url(name).path), FileManager.default.contents(atPath: path), "a copy, as it was")
        for p in PaperPlace.allCases { XCTAssertEqual(s.paper(on: p), .picture(name)) }
        // The same picture again is the same file.
        _ = try PaperOps.set(path, on: [.desktop], file: file, cwd: "/").get()
        XCTAssertEqual(store.pictures(), [name])
    }

    func testAllClearsEachPlacesOwnAndFewerSetOnlyThose() throws {
        _ = try PaperOps.set("#112233", on: [.newtab], file: file, cwd: "/").get()
        XCTAssertEqual(tree()?.at(["newtab", "paper"]), .string("#112233"))
        XCTAssertNil(tree()?.at(["paper"]))
        _ = try PaperOps.set("water", on: Set(PaperPlace.allCases), file: file, cwd: "/").get()
        XCTAssertEqual(tree()?.at(["paper"]), .string("water"))
        XCTAssertNil(tree()?.at(["newtab", "paper"]), "all means every place shows it")
        XCTAssertEqual(try surfaces().paper(on: .newtab), .scene(.water))
    }

    func testResetOnePlaceLeavesTheOthersShowingTheSharedPaper() throws {
        _ = try PaperOps.set("olive", on: Set(PaperPlace.allCases), file: file, cwd: "/").get()
        _ = try PaperOps.reset(on: [.desktop], file: file).get()
        let s = try surfaces()
        XCTAssertNil(s.paper(on: .desktop), "the desktop is back to the theme's")
        XCTAssertEqual(s.paper(on: .newtab), .scene(.olive))
        XCTAssertEqual(s.paper(on: .idle), .scene(.olive))
        _ = try PaperOps.reset(on: Set(PaperPlace.allCases), file: file).get()
        let back = try surfaces()
        XCTAssertNil(back.paper)
        for p in PaperPlace.allCases { XCTAssertNil(back.paper(on: p)) }
        XCTAssertEqual(back, Surfaces.defaults, "reset is exactly as before paper")
    }

    func testARefusedPaperWritesNothing() throws {
        let text = try write(Data("not a picture".utf8), "fake.png")
        guard case .failure(let f) = PaperOps.set(text, on: [], file: file, cwd: "/") else { return XCTFail("a text file is no picture") }
        XCTAssertEqual(f.code, "not_a_picture")
        let gif = try write(try picture(width: 8, height: 8, type: .gif), "a.png")
        guard case .failure(let g) = PaperOps.set(gif, on: [], file: file, cwd: "/") else { return XCTFail("a GIF is not a paper") }
        XCTAssertEqual(g.code, "not_a_picture")
        guard case .failure(let m) = PaperOps.set(dir.appendingPathComponent("gone.jpg").path, on: [], file: file, cwd: "/") else { return XCTFail() }
        XCTAssertEqual(m.code, "not_found")
        guard case .failure(let u) = PaperOps.set("https://example.com/a.jpg", on: [], file: file, cwd: "/",
                                                  fetch: { _ in .success(Data("<html>".utf8)) }) else { return XCTFail() }
        XCTAssertEqual(u.code, "not_a_picture", "a page where a picture should be is refused")
        XCTAssertEqual(SurfacesFile.load(path: file), .missing, "nothing was written")
        XCTAssertEqual(store.pictures(), [])
    }

    /// A PNG that claims `width` by `height` in a few kilobytes: 1-bit rows of zeros, deflated. Its header is whole, so
    /// ImageIO reads its size, and a decode would take `width * height * 4` bytes. `header` leaves out the pixel data
    /// altogether.
    private func bombPNG(width: Int, height: Int, header: Bool = false) -> Data {
        func be(_ v: Int) -> [UInt8] { [UInt8(v >> 24 & 0xFF), UInt8(v >> 16 & 0xFF), UInt8(v >> 8 & 0xFF), UInt8(v & 0xFF)] }
        func chunk(_ type: String, _ body: [UInt8]) -> [UInt8] {
            let t = Array(type.utf8)
            let c = body.withUnsafeBufferPointer { crc32(crc32(0, t, UInt32(t.count)), $0.baseAddress, UInt32(body.count)) }
            return be(body.count) + t + body + be(Int(c))
        }
        var pixels: [UInt8] = []
        if !header {
            var z = z_stream()
            deflateInit_(&z, 9, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
            let row = [UInt8](repeating: 0, count: 1 + (width + 7) / 8)
            var buf = [UInt8](repeating: 0, count: 1 << 16)
            for i in 0..<height {
                row.withUnsafeBufferPointer { r in
                    z.next_in = UnsafeMutablePointer(mutating: r.baseAddress)
                    z.avail_in = UInt32(r.count)
                    repeat {
                        buf.withUnsafeMutableBufferPointer { o in
                            z.next_out = o.baseAddress
                            z.avail_out = UInt32(o.count)
                            deflate(&z, i == height - 1 ? Z_FINISH : Z_NO_FLUSH)
                            pixels += o[0..<(o.count - Int(z.avail_out))]
                        }
                    } while z.avail_out == 0
                }
            }
            deflateEnd(&z)
        }
        let signature: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
        return Data(signature + chunk("IHDR", be(width) + be(height) + [1, 0, 0, 0, 0])
                    + (header ? [] : chunk("IDAT", pixels)) + chunk("IEND", []))
    }

    func testAPictureTooManyPixelsToDecodeIsRefusedFromItsHeader() throws {
        for (w, h) in [(16385, 100), (100, 16385), (12000, 9000), (20000, 20000)] {
            let png = bombPNG(width: w, height: h)
            XCTAssertLessThan(png.count, 64 * 1024, "a few kilobytes claim \(w) by \(h)")
            guard case .failure(let f) = store.add(png) else { return XCTFail("\(w) by \(h) is too many pixels") }
            XCTAssertEqual(f.code, "too_large", "\(w) by \(h): \(f.message)")
            let path = try write(png, "huge-\(w)x\(h).png")
            guard case .failure(let g) = PaperOps.set(path, on: [], file: file, cwd: "/") else { return XCTFail() }
            XCTAssertEqual(g.code, "too_large")
            XCTAssertNil(PaperImage.thumbnail(URL(fileURLWithPath: path), longest: 64), "never decoded for the idle screen")
            XCTAssertNil(PaperImage.dataURL(URL(fileURLWithPath: path)), "never decoded for the new tab")
        }
        // Only a header: ImageIO won't say its size, so it is refused before any decode as no picture.
        guard case .failure(let f) = store.add(bombPNG(width: 60000, height: 60000, header: true)) else { return XCTFail() }
        XCTAssertEqual(f.code, "not_a_picture")
        XCTAssertEqual(store.pictures(), [])
        XCTAssertNoThrow(try store.add(bombPNG(width: 4000, height: 3000)).get(), "12 megapixels still go in")
    }

    func testAFileThatWouldRefuseThePaperGetsNoPictureCopiedIn() throws {
        try Data(##"{"version": 1, "desktop": {"followDaylight": "yes"}}"##.utf8).write(to: URL(fileURLWithPath: file))
        let png = try write(try picture(width: 32, height: 20), "a.png")
        guard case .failure(let f) = PaperOps.set(png, on: [], file: file, cwd: "/") else { return XCTFail("the file has errors") }
        XCTAssertEqual(f.code, "invalid_file")
        var fetched = false
        guard case .failure(let u) = PaperOps.set("https://example.com/a.png", on: [], file: file, cwd: "/",
                                                  fetch: { _ in fetched = true; return .failure(PaperFailure("fetch_failed", "")) }) else { return XCTFail() }
        XCTAssertEqual(u.code, "invalid_file")
        XCTAssertFalse(fetched, "nothing is fetched for a file that would refuse it")
        XCTAssertEqual(store.pictures(), [], "nothing copied in")
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.folder.path))
    }

    func testAWriteThatFailsTakesTheNewPictureBackOut() throws {
        let png = try write(try picture(width: 32, height: 20), "a.png")
        let kept = try store.add(try picture(width: 8, height: 8, seed: 9)).get()
        // Papers/ can take a picture but surfaces.json's folder can't take the file.
        let fm = FileManager.default
        try fm.setAttributes([.posixPermissions: 0o555], ofItemAtPath: dir.path)
        defer { try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path) }
        guard case .failure(let f) = PaperOps.set(png, on: [], file: file, cwd: "/") else { return XCTFail("the file can't be written") }
        XCTAssertEqual(f.code, "io_error")
        XCTAssertEqual(store.pictures(), [kept], "the new copy is gone; the one that was there stays")
    }

    func testALoopbackOrPrivateURLIsNeverFetched() throws {
        for u in ["https://127.0.0.1:9/a.png", "https://localhost/a.png", "https://LOCALHOST./a.png", "https://app.localhost/a.png",
                  "https://printer.local/a.png", "https://[::1]/a.png", "https://[fe80::1]/a.png", "https://[fd00::1]/a.png",
                  "https://[::ffff:127.0.0.1]/a.png", "https://10.0.0.1/a.png", "https://172.16.4.2/a.png", "https://192.168.1.1/a.png",
                  "https://169.254.169.254/latest", "https://100.64.0.1/a.png", "https://0.0.0.0/a.png", "https://2130706433/a.png"] {
            let url = try XCTUnwrap(URL(string: u))
            XCTAssertNotNil(PaperDownload.refusal(url), u)
            guard case .failure(let f) = PaperDownload.fetch(url, timeout: 2) else { return XCTFail("\(u) was fetched") }
            XCTAssertEqual(f.code, "invalid_paper", u)
        }
        guard case .failure(let f) = PaperOps.set("https://127.0.0.1:9/a.png", on: [], file: file, cwd: "/") else { return XCTFail() }
        XCTAssertEqual(f.code, "invalid_paper", "the command refuses it through the real fetch")
        XCTAssertEqual(store.pictures(), [])
        for ip in ["8.8.8.8", "93.184.216.34", "2606:4700::1111", "172.32.0.1", "100.128.0.1"] {
            XCTAssertEqual(PaperDownload.privateAddress(ip), false, ip)
        }
        XCTAssertNil(PaperDownload.privateAddress("example.com"))
        XCTAssertNil(PaperDownload.refusal(try XCTUnwrap(URL(string: "https://93.184.216.34/a.png")), resolve: false))
    }

    func testAScenePaperOverASolidDesktopTurnsWithTheDay() throws {
        var s = Surfaces.defaults
        s.desktop.scene = .solid
        s.desktop.followDaylight = true
        let now = Date()
        let theme: ThemeWallpaper = .gradient(RGB(r: 1, g: 1, b: 1), RGB(r: 0, g: 0, b: 0))
        XCTAssertNil(s.nextDesktopTurn(theme, after: now), "the theme's own picture never turns")
        s.paper = .scene(.olive)
        XCTAssertEqual(s.drawnDesktop.scene, .olive, "the paper is what is drawn")
        let want = s.paper(on: .desktop)?.wallpaper(desktop: s.desktop, papers: store.folder, at: now, systemDark: false, themeOwn: { theme })
        guard case .scene? = want else { return XCTFail("olive is drawn as a scene") }
        let next = try XCTUnwrap(s.nextDesktopTurn(want, after: now), "the drawn scene schedules its next light")
        XCTAssertGreaterThan(next, now)
        s.paper = nil
        XCTAssertNil(s.nextDesktopTurn(want, after: now), "desktop.scene alone is solid, so it is the paper that turns")
    }

    func testAFetchedPictureIsKeptLikeAFile() throws {
        let png = try picture(width: 32, height: 20)
        var asked: URL?
        _ = try PaperOps.set("https://example.com/sunset.png", on: [.desktop], file: file, cwd: "/",
                             fetch: { asked = $0; return .success(png) }).get()
        XCTAssertEqual(asked?.absoluteString, "https://example.com/sunset.png")
        guard case .picture(let name)? = try surfaces().desktop.paper else { return XCTFail("the desktop has the picture") }
        XCTAssertEqual(FileManager.default.contents(atPath: store.url(name).path), png)
    }

    func testOverTwentyFiveMegabytesIsRefused() {
        guard case .failure(let f) = store.add(Data(count: PaperStore.maxBytes + 1)) else { return XCTFail("over the cap") }
        XCTAssertEqual(f.code, "too_large")
    }

    func testPruningKeepsTheNewestTenAndEveryOneInUse() throws {
        let fm = FileManager.default
        var names: [String] = []
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        for i in 0..<13 {
            let n = try store.add(try picture(width: 4, height: 4, seed: UInt8(i + 1)), now: start.addingTimeInterval(Double(i) * 60)).get()
            names.append(n)
        }
        XCTAssertEqual(Set(names).count, 13)
        // The oldest is in use; a new tab copy of the second oldest is there too.
        try fm.createDirectory(at: store.newtab, withIntermediateDirectories: true)
        try Data("x".utf8).write(to: store.newtab.appendingPathComponent(names[1] + ".jpg"))
        let removed = store.prune(inUse: [names[0]])
        XCTAssertEqual(Set(removed), Set([names[1], names[2]]))
        XCTAssertEqual(Set(store.pictures()), Set(names[3...] + [names[0]]))
        XCTAssertFalse(fm.fileExists(atPath: store.newtab.appendingPathComponent(names[1] + ".jpg").path), "its new tab copy went with it")
    }

    func testSetPrunesWhatNoPaperNames() throws {
        for i in 0..<12 {
            let p = try write(try picture(width: 4, height: 4, seed: UInt8(i + 1)), "p\(i).png")
            _ = try PaperOps.set(p, on: [], file: file, cwd: "/").get()
        }
        XCTAssertEqual(store.pictures().count, PaperStore.keep)
        guard case .picture(let last)? = try surfaces().paper else { return XCTFail() }
        XCTAssertEqual(store.pictures().first, last)
    }

    // MARK: The new tab

    func testTheNewTabGetsEachKindOfPaper() throws {
        func reply(_ json: String) throws -> [String: Any] {
            let s = try Surfaces.check(try SurfaceValue.parse(Data(json.utf8)).get()).get().surfaces
            let data = NewTabHost.answer(Data(#"{"op":"page"}"#.utf8), source: NewTabHost.Source(surfaces: { s }, papers: store))
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        XCTAssertEqual(try reply(##"{"paper":"#2b2e26"}"##)["paper"] as? [String: String], ["color": "#2B2E26"])
        XCTAssertEqual(try reply(#"{"paper":"olive","newtab":{"paper":"field"}}"#)["paper"] as? [String: String], ["scene": "field"])
        XCTAssertNil(try reply(#"{"paper":"picture:paper-0123456789abcdef.jpg"}"#)["paper"], "a picture that is gone is no paper")
        XCTAssertNil(try reply(#"{"desktop":{"paper":"olive"}}"#)["paper"], "the desktop's own is not the new tab's")
    }

    /// Chrome refuses a native message reply over 1 MB, and the page goes blank. A large photo is sent at most 1920 px wide
    /// and under 700 KB.
    func testABigPictureIsSentSmallEnoughForChrome() throws {
        let big = try write(try picture(width: 3200, height: 2000, type: .jpeg, noise: true), "noise.jpg")
        XCTAssertGreaterThan(try Data(contentsOf: URL(fileURLWithPath: big)).count, NewTabHost.maxMessage, "a picture Chrome could never take whole")
        _ = try PaperOps.set(big, on: [.newtab], file: file, cwd: "/").get()
        let s = try surfaces()
        let data = NewTabHost.answer(Data(#"{"op":"page"}"#.utf8), source: NewTabHost.Source(surfaces: { s }, papers: store))
        XCTAssertLessThan(data.count, NewTabHost.maxMessage, "under Chrome's 1 MB")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let image = try XCTUnwrap((object["paper"] as? [String: String])?["image"])
        XCTAssertLessThan(image.utf8.count, PaperImage.newTabBytes)
        XCTAssertTrue(image.hasPrefix("data:image/jpeg;base64,"))
        let jpeg = try XCTUnwrap(Data(base64Encoded: String(image.dropFirst("data:image/jpeg;base64,".count))))
        let src = try XCTUnwrap(CGImageSourceCreateWithData(jpeg as CFData, nil))
        let props = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any])
        let w = try XCTUnwrap(props[kCGImagePropertyPixelWidth] as? Int), h = try XCTUnwrap(props[kCGImagePropertyPixelHeight] as? Int)
        XCTAssertLessThanOrEqual(w, PaperImage.newTabWidth)
        XCTAssertEqual(Double(w) / Double(h), 1.6, accuracy: 0.01, "the shape is kept")
        // The second ask reads the copy it made.
        guard case .picture(let name)? = s.newtab.paper else { return XCTFail() }
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.newtab.appendingPathComponent(name + ".jpg").path))
        XCTAssertEqual(NewTabHost.answer(Data(#"{"op":"page"}"#.utf8), source: NewTabHost.Source(surfaces: { s }, papers: store)), data)
    }

    func testASmallPictureIsNotMadeLarger() throws {
        let p = try write(try picture(width: 300, height: 200), "small.png")
        let url = try XCTUnwrap(PaperImage.dataURL(URL(fileURLWithPath: p)))
        let jpeg = try XCTUnwrap(Data(base64Encoded: String(url.dropFirst("data:image/jpeg;base64,".count))))
        let props = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(try XCTUnwrap(CGImageSourceCreateWithData(jpeg as CFData, nil)), 0, nil) as? [CFString: Any])
        XCTAssertEqual(props[kCGImagePropertyPixelWidth] as? Int, 300)
    }

    // MARK: The desktop and the idle screen

    func testAPaperWinsOverTheThemesPictureAndResetBringsTheOwnBack() throws {
        let papers = store.folder
        let name = try store.add(try picture(width: 64, height: 40, type: .jpeg)).get()
        let d = ThemeWallpaperTests.FakeDesktop()
        let own = dir.appendingPathComponent("beach.jpg")
        try Data("beach".utf8).write(to: own)
        d.shown = ["A": (own, PictureOptions(scaling: 3, allowClipping: false))]
        let k = WallpaperKeeper(folder: dir.appendingPathComponent("Wallpaper"), desktop: d, papersFolder: papers)
        let theme: ThemeWallpaper = .solid(RGB(r: 0.2, g: 0.2, b: 0.2))
        let w = try XCTUnwrap(Paper.picture(name).wallpaper(desktop: Surfaces.defaults.desktop, papers: papers, at: Date(), systemDark: false,
                                                            themeOwn: { theme }))
        XCTAssertEqual(w, .picture(store.url(name)))
        XCTAssertEqual(k.sync(w).set, ["A"])
        XCTAssertEqual(d.shown["A"]!.url, store.url(name))
        XCTAssertEqual(d.shown["A"]!.options, PictureOptions(scaling: 3, allowClipping: true), "a photo fills the screen")
        XCTAssertTrue(k.isOurs(store.url(name)), "a paper is never kept as the person's own")
        // Reset with the theme's wallpaper on: the theme's shows, and the own picture is still the one recorded.
        XCTAssertEqual(k.sync(theme).set, ["A"])
        XCTAssertEqual(k.saved.map(\.url), [own])
        XCTAssertEqual(k.sync(nil).restored, ["A"])
        XCTAssertEqual(d.shown["A"]!.url, own)
    }

    func testEachPaperBecomesTheDesktopsPicture() throws {
        let papers = store.folder
        let desk = Surfaces.defaults.desktop
        let theme: ThemeWallpaper = .gradient(RGB(r: 1, g: 1, b: 1), RGB(r: 0, g: 0, b: 0))
        func wall(_ p: Paper) -> ThemeWallpaper? { p.wallpaper(desktop: desk, papers: papers, at: Date(), systemDark: false, themeOwn: { theme }) }
        XCTAssertEqual(wall(.color(RGB(hex: "#112233")!)), .solid(RGB(hex: "#112233")!))
        XCTAssertEqual(wall(.scene(.solid)), theme, "solid is the theme's own")
        guard case .scene(let s)? = wall(.scene(.water)) else { return XCTFail("water is a scene") }
        XCTAssertEqual(s.kind, .water)
        XCTAssertNil(wall(.picture("paper-0123456789abcdef.jpg")), "a picture that is gone falls back")
    }

    func testTheIdleScreenGetsThePaperAsAPicture() throws {
        let papers = store.folder
        let name = try store.add(try picture(width: 400, height: 250)).get()
        let desk = Surfaces.defaults.desktop
        let photo = try XCTUnwrap(Paper.picture(name).image(width: 200, height: 100, desktop: desk, papers: papers, at: Date(),
                                                            systemDark: true, background: RGB(r: 0, g: 0, b: 0)))
        XCTAssertEqual(max(photo.width, photo.height), 200)
        XCTAssertNotNil(Paper.color(RGB(r: 1, g: 0, b: 0)).image(width: 10, height: 10, desktop: desk, papers: papers, at: Date(),
                                                                  systemDark: true, background: RGB(r: 0, g: 0, b: 0)))
        let scene = try XCTUnwrap(Paper.scene(.olive).image(width: 64, height: 40, desktop: desk, papers: papers, at: Date(),
                                                            systemDark: true, background: RGB(r: 0, g: 0, b: 0)))
        XCTAssertEqual(scene.width, 64)
    }
}
