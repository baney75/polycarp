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

    /// The router is in the app target: its snapshot captures only on screenshot: true, and both verbs report points.
    func testTheRouterCapturesOnRequestAndReportsPoints() throws {
        let src = try HandsSourceTests.code("Sources/BaneySpaces/Hands/HandsRouter.swift")
        let snap = try XCTUnwrap(HandsSourceTests.block(after: "private func snapshot(_ req: HandsRequest)", in: src))
        XCTAssertTrue(snap.contains(#"guard req.bool("screenshot") else"#))
        XCTAssertTrue(snap.contains("if let e = gate(w, session:"), "the same gate as shot")
        XCTAssertTrue(snap.contains(#""points": Self.pointsJSON(r.points)"#))
        XCTAssertTrue(src.components(separatedBy: #""points": Self.pointsJSON(r.points)"#).count == 3, "shot and snapshot")
    }
}
