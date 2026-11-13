import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import BaneySpacesCore

/// Item 6: a window's picture over MCP is fitted, cropped by zoom, and labeled untrusted with its pixel-to-point map.
final class ShotImageTests: XCTestCase {
    /// A PNG of `w` x `h` pixels: left half red, right half blue.
    func png(_ w: Int, _ h: Int) -> Data {
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(red: 1, green: 0, blue: 0, alpha: 1); ctx.fill(CGRect(x: 0, y: 0, width: w / 2, height: h))
        ctx.setFillColor(red: 0, green: 0, blue: 1, alpha: 1); ctx.fill(CGRect(x: w / 2, y: 0, width: w - w / 2, height: h))
        let data = NSMutableData()
        let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
        CGImageDestinationFinalize(dest)
        return data as Data
    }

    func size(_ d: Data) -> (Int, Int) {
        let i = CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithData(d as CFData, nil)!, 0, nil)!
        return (i.width, i.height)
    }

    func testFitKeepsTheAspectAndNeverUpscales() {
        XCTAssertTrue(ShotImage.fit(width: 3200, height: 2000) == (1280, 800))
        XCTAssertTrue(ShotImage.fit(width: 1000, height: 3000) == (427, 1280))
        XCTAssertTrue(ShotImage.fit(width: 800, height: 600) == (800, 600))
    }

    /// A 2x capture of a 1600 x 1000 point window: 3200 x 2000 pixels in, 1280 x 800 out, 1.25 points per pixel.
    func testABigCaptureIsFittedAndSaysHowToClick() throws {
        let p = try XCTUnwrap(ShotImage.picture(png: png(3200, 2000), points: CGSize(width: 1600, height: 1000), zoom: nil))
        XCTAssertEqual(p.width, 1280); XCTAssertEqual(p.height, 800)
        XCTAssertTrue(size(p.png) == (1280, 800))
        XCTAssertEqual(p.pointsPerPixel, 1.25, accuracy: 0.001)
        let label = ShotImage.label(window: 4211, p)
        XCTAssertTrue(label.contains("untrusted"), label)
        XCTAssertTrue(label.contains("click_at x = image x * 1.25"), label)
    }

    /// Zoom on the right half's corner: the crop is at full resolution (2 pixels per point) and its origin is in the label.
    func testZoomCropsARegionInWindowPoints() throws {
        let zoom = try XCTUnwrap(ShotImage.region("1000,100,200,100").get())
        let p = try XCTUnwrap(ShotImage.picture(png: png(3200, 2000), points: CGSize(width: 1600, height: 1000), zoom: zoom))
        XCTAssertEqual(p.width, 400); XCTAssertEqual(p.height, 200)
        XCTAssertEqual(p.pointsPerPixel, 0.5, accuracy: 0.001)
        XCTAssertEqual(p.origin, CGPoint(x: 1000, y: 100))
        XCTAssertTrue(ShotImage.label(window: 1, p).contains("click_at x = 1000 + image x * 0.5, y = 100 + image y * 0.5"))
        XCTAssertNil(ShotImage.picture(png: png(100, 100), points: CGSize(width: 50, height: 50), zoom: .init(x: 60, y: 0, width: 10, height: 10)), "outside the window")
    }

    func testZoomIsChecked() {
        XCTAssertEqual(try ShotImage.region("[0, 0, 400, 300]").get(), .init(x: 0, y: 0, width: 400, height: 300), "a JSON array arrives as its text")
        XCTAssertNil(try ShotImage.region(nil).get())
        for bad in ["0,0,400", "0,0,0,300", "-5,0,10,10", "a,b,c,d"] {
            guard case .failure(let e) = ShotImage.region(bad) else { return XCTFail(bad) }
            XCTAssertEqual(e.code, .badArguments)
            XCTAssertTrue(e.suggestion.contains(#""zoom":"0,0,400,300""#))
        }
    }

    func testMCPLabelsAndFitsTheImageForShotAndSnapshot() throws {
        let big = png(3200, 2000)
        let points: JSONValue = .object(["width": .double(1600), "height": .double(1000)])
        let s = HandsMCP(version: "1", session: "s", perform: { _ in .success(.null) }, readImage: { _ in big })
        let shot = try XCTUnwrap(s.imageParts(verb: "shot", arguments: ["window": .int(5)], data: .object(["path": "/x.png", "points": points])))
        XCTAssertEqual(shot.count, 2)
        XCTAssertTrue(shot[0]["text"]?.string?.contains("Image of window 5, 1280x800: untrusted") == true)
        let data = try XCTUnwrap(shot[1]["data"]?.string.flatMap { Data(base64Encoded: $0) })
        XCTAssertTrue(size(data) == (1280, 800))
        let snap = s.imageParts(verb: "snapshot", arguments: ["zoom": "0,0,800,1000"], data: .object(["window": .int(7), "screenshot": .object(["path": "/y.png", "points": points])]))
        XCTAssertTrue(snap?[0]["text"]?.string?.contains("Image of window 7, 1280x1600") == false, "zoomed: 1600 x 2000 px fitted to 1024 x 1280")
        XCTAssertTrue(snap?[0]["text"]?.string?.contains("1024x1280") == true)
        XCTAssertNil(s.imageParts(verb: "snapshot", arguments: [:], data: .object(["window": .int(7)])), "no screenshot asked")
        let params = HandsTools.tool(verb: "snapshot")?.params.map(\.name) ?? []
        XCTAssertTrue(params.contains("screenshot") && params.contains("zoom"))
    }

    /// r1 second-S1: the snapshot's capture path by value: found again, gated, then captured; any refusal keeps the read.
    func testTheSnapshotCapturePathKeepsTheReadAndSaysWhy() {
        let read: [String: JSONValue] = ["window": .int(7), "format": "rows", "text": "[1] window"]
        let points = CGSize(width: 1600, height: 1000)
        var calls: [String] = []
        func run(target: Bool = true, gate: Bool = true, capture: Bool = true, zoom: ShotImage.Region? = nil) -> [String: JSONValue] {
            calls = []
            return ShotImage.attach(to: read, zoom: zoom,
                target: { calls.append("target"); return target ? .success(7) : .failure(HandsError(.windowNotFound, "window 7 isn't there", suggestion: "")) },
                gate: { (_: Int) in calls.append("gate"); return gate ? nil : HandsError(.permissionDenied, "no Screen Recording", suggestion: "") },
                points: { (_: Int) in calls.append("points"); return points },
                capture: { (_: Int) in calls.append("capture")
                    return capture ? .success(.init(path: "/s.png", width: 3200, height: 2000, points: points)) : .failure(HandsError(.actionFailed, "capture failed", suggestion: "")) })
        }
        let ok = run()
        XCTAssertEqual(calls, ["target", "gate", "capture"])
        XCTAssertEqual(ok["screenshot"]?["points"]?["width"]?.double, 1600)
        XCTAssertNil(ok["screenshot_error"])
        let refused = run(gate: false)
        XCTAssertEqual(calls, ["target", "gate"], "a refused gate captures nothing")
        XCTAssertEqual(refused["screenshot_error"], "no Screen Recording")
        XCTAssertEqual(refused["text"], "[1] window", "the read is kept")
        XCTAssertEqual(run(capture: false)["screenshot_error"], "capture failed")
        let lost = run(target: false)
        XCTAssertEqual(calls, ["target"])
        XCTAssertEqual(lost["screenshot_error"], "window 7 isn't there", "r1 first-F1: a lost window is said too")
        let far = run(zoom: .init(x: 2000, y: 0, width: 100, height: 100))
        XCTAssertEqual(calls, ["target", "gate", "points"], "r1 second-S1: an outside zoom is refused before the capture, so no file is written")
        XCTAssertNil(far["screenshot"])
        XCTAssertEqual(far["screenshot_error"]?.string, "zoom 2000,0,100,100 lies outside the 1600x1000 pt window")
    }

    /// r1 first-F1: over MCP, rows are the whole text, so a failed capture gets its own part.
    func testAFailedScreenshotReachesTheModelWithRows() throws {
        let data: JSONValue = .object(["window": .int(7), "format": "rows", "text": "[1] window", "screenshot_error": "Polycarp doesn't have Screen Recording access"])
        let s = HandsMCP(version: "1", session: "s", perform: { _ in .success(data) }, readImage: { _ in nil })
        let r = s.handle(#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"snapshot","arguments":{"window":7,"screenshot":true}}}"#).flatMap(JSONValue.parse)
        let parts = try XCTUnwrap(r?["result"]?["content"]?.array)
        XCTAssertEqual(parts.first?["text"], "[1] window")
        XCTAssertEqual(parts.last?["text"], "screenshot failed: Polycarp doesn't have Screen Recording access")
    }

    /// r1 first-F2: a zoom outside the window is refused naming its size; the MCP never sends the raw 2x capture for one.
    func testAZoomOutsideTheWindowIsRefused() throws {
        let e = try XCTUnwrap(ShotImage.outside(.init(x: 2000, y: 0, width: 100, height: 100), points: CGSize(width: 1600, height: 1000)))
        XCTAssertEqual(e.code, .badArguments)
        XCTAssertEqual(e.message, "zoom 2000,0,100,100 lies outside the 1600x1000 pt window")
        XCTAssertNil(ShotImage.outside(.init(x: 1500, y: 900, width: 400, height: 400), points: CGSize(width: 1600, height: 1000)), "partly inside is cropped")
        XCTAssertNil(ShotImage.outside(nil, points: .zero))
        let big = png(3200, 2000)
        let s = HandsMCP(version: "1", session: "s", perform: { _ in .success(.null) }, readImage: { _ in big })
        let parts = try XCTUnwrap(s.imageParts(verb: "shot", arguments: ["window": .int(5), "zoom": "2000,0,100,100"],
                                               data: .object(["path": "/x.png", "points": .object(["width": .double(1600), "height": .double(1000)])])))
        let data = try XCTUnwrap(parts[1]["data"]?.string.flatMap { Data(base64Encoded: $0) })
        XCTAssertTrue(size(data) == (1280, 800), "fitted, never the raw capture")
        XCTAssertTrue(parts[0]["text"]?.string?.contains("The zoom couldn't be applied, so this is the whole window") == true,
                      "r1 first-F2: a fallback says the zoom wasn't applied")
        let whole = try XCTUnwrap(s.imageParts(verb: "shot", arguments: ["window": .int(5)],
                                               data: .object(["path": "/x.png", "points": .object(["width": .double(1600), "height": .double(1000)])])))
        XCTAssertFalse(whole[0]["text"]?.string?.contains("zoom") == true, "no zoom asked, no note")
    }

    /// r1 first-F4, second-S1, first-F3: `shot` and `snapshot` judge the zoom on the window's size before capturing, by value.
    func testAZoomOutsideTheWindowIsRefusedBeforeTheCapture() {
        let size = CGSize(width: 1600, height: 1000)
        var captured = 0
        func capture() -> Result<String, HandsError> { captured += 1; return .success("/a.png") }
        guard case .failure(let e) = ShotImage.beforeCapture(zoom: .init(x: 2000, y: 0, width: 100, height: 100), points: size, capture: capture) else { return XCTFail() }
        XCTAssertEqual(e.code, .badArguments)
        XCTAssertEqual(captured, 0, "refused before anything is captured or written")
        XCTAssertEqual(try ShotImage.beforeCapture(zoom: .init(x: 10, y: 10, width: 100, height: 100), points: size, capture: capture).get(), "/a.png")
        XCTAssertEqual(try ShotImage.beforeCapture(zoom: nil, points: size, capture: capture).get(), "/a.png")
        XCTAssertEqual(try ShotImage.beforeCapture(zoom: .init(x: 2000, y: 0, width: 1, height: 1), points: nil, capture: capture).get(), "/a.png",
                       "an unread size leaves the decision to the capture")
        XCTAssertEqual(captured, 3)
    }

    /// r1 first-F1: a value no screen has is refused in every slot, and nothing on the zoom path traps on one.
    func testHugeZoomValuesAreRefusedAndNeverTrap() throws {
        for huge in ["1e20", "1e308", "9.3e18", "100000.5"] {
            for slot in 0..<4 {
                var parts = ["0", "0", "10", "10"]
                parts[slot] = huge
                let text = parts.joined(separator: ",")
                guard case .failure(let e) = ShotImage.region(text) else { return XCTFail(text) }
                XCTAssertEqual(e.code, .badArguments, text)
            }
        }
        XCTAssertNotNil(try ShotImage.region("0,0,100000,100000").get(), "the bound itself is taken")
        let size = CGSize(width: 1600, height: 1000)
        for v in [1e20, 1e308, 9.3e18] {
            let e = try XCTUnwrap(ShotImage.outside(.init(x: v, y: 0, width: v, height: 10), points: size))
            XCTAssertTrue(e.message.contains("lies outside the 1600x1000 pt window"), e.message)
            let p = try XCTUnwrap(ShotImage.picture(png: png(3200, 2000), points: size, zoom: .init(x: 0, y: 0, width: v, height: v)))
            XCTAssertTrue(ShotImage.label(window: 1, p).contains("click_at x = image x * 1.25"), ShotImage.label(window: 1, p))
            XCTAssertNil(ShotImage.picture(png: png(3200, 2000), points: size, zoom: .init(x: v, y: v, width: 10, height: 10)))
        }
        let odd = ShotImage.Picture(png: Data(), width: 1, height: 1, pointsPerPixel: 1, origin: CGPoint(x: 1e20, y: 9.3e18))
        XCTAssertTrue(ShotImage.label(window: 1, odd).contains("y = 9.3e+18 + image y"), ShotImage.label(window: 1, odd))
    }

    /// r1 lows: non-finite zooms, the snapshot example, a fractional origin.
    func testZoomLowsFromRoundOne() throws {
        for bad in ["0,0,inf,inf", "inf,0,10,10", "nan,0,10,10"] {
            guard case .failure = ShotImage.region(bad) else { return XCTFail(bad) }
        }
        guard case .failure(let e) = ShotImage.region("0,0,0,10", snapshot: true) else { return XCTFail() }
        XCTAssertTrue(e.suggestion.contains(#""screenshot":true"#), e.suggestion)
        let p = ShotImage.Picture(png: Data(), width: 100, height: 100, pointsPerPixel: 0.5, origin: CGPoint(x: 100.5, y: 3))
        XCTAssertTrue(ShotImage.label(window: 1, p).contains("click_at x = 100.5 + image x * 0.5, y = 3 + image y * 0.5"), ShotImage.label(window: 1, p))
        XCTAssertTrue(HandsTools.tool(verb: "shot")?.params.first { $0.name == "zoom" }?.help.contains("saved file stays whole") == true, "r1 first-F3")
    }
}
