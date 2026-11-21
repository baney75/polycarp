#if canImport(ImageIO)
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Photos decoded no larger than the screen needs (spec/player.md, R-P4). Call it off the main thread: the photo comes
/// back fully decoded in a bitmap Polycarp owns, so putting it on screen costs no decode on the main thread.
///
/// Measured on an M-series Mac under heavy load (a 4000 x 3000 JPEG, best of 9): `CGImageSourceCreateThumbnailAtIndex`
/// at an arbitrary size such as 3024 px resamples on the CPU and took 195 to 590 ms at best. A plain decode drawn into a bitmap
/// took 33 ms, and one with `kCGImageSourceSubsampleFactor` 2 took 14 ms. So the decode picks the largest factor of 1,
/// 2, 4 or 8 whose result still covers the screen, and Core Animation does the last bit of scaling on the GPU.
/// `ShouldCacheImmediately` alone is not enough: on its own, `CGImageSourceCreateImageAtIndex` returns at once and
/// decodes on first use, which would be Core Animation's commit on the main thread. Camera raw keeps ImageIO's
/// thumbnail path, which renders the raw data at the size asked for.
public enum PhotoDecode {
    /// The photo at `url`, upright, at the smallest decode that still fills a `screen` (in pixels). Nil when ImageIO
    /// can't read it.
    public static func image(at url: URL, screen: CGSize) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
        let w = props[kCGImagePropertyPixelWidth] as? Int ?? 0, h = props[kCGImagePropertyPixelHeight] as? Int ?? 0
        let orientation = props[kCGImagePropertyOrientation] as? Int ?? 1
        let isRaw = (CGImageSourceGetType(source) as String?).map(Self.isRaw) ?? false
        if isRaw || w == 0 || h == 0 {
            let upright = orientation >= 5 ? CGSize(width: h, height: w) : CGSize(width: w, height: h)
            let fitted = fit(upright, in: screen)
            return thumbnail(source, maxPixels: Int(max(fitted.width, fitted.height, 1).rounded(.up))).flatMap { bitmap($0, orientation: 1) }
        }
        let factor = subsample(width: w, height: h, orientation: orientation, screen: screen)
        var options: [CFString: Any] = [kCGImageSourceShouldCacheImmediately: true]
        if factor > 1 { options[kCGImageSourceSubsampleFactor] = factor }
        guard let image = CGImageSourceCreateImageAtIndex(source, 0, options as CFDictionary) else { return nil }
        return bitmap(image, orientation: orientation)
    }

    /// ImageIO's own path: a thumbnail at `maxPixels`, turned upright. Slow at sizes that aren't a power-of-two
    /// fraction of the photo, so only for camera raw.
    static func thumbnail(_ source: CGImageSource, maxPixels: Int) -> CGImage? {
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(1, maxPixels),
        ] as CFDictionary
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options)
    }

    /// The size a photo of `size` is drawn at to fit inside `screen`, never larger than it is.
    public static func fit(_ size: CGSize, in screen: CGSize) -> CGSize {
        guard size.width > 0, size.height > 0, screen.width > 0, screen.height > 0 else { return size }
        let s = min(1, screen.width / size.width, screen.height / size.height)
        return CGSize(width: size.width * s, height: size.height * s)
    }

    /// The largest of 1, 2, 4 and 8 that leaves a `width` x `height` photo (as stored; `orientation` 5 to 8 turns it)
    /// at least as large as it is drawn on `screen`.
    public static func subsample(width: Int, height: Int, orientation: Int = 1, screen: CGSize) -> Int {
        let upright = orientation >= 5 ? CGSize(width: height, height: width) : CGSize(width: width, height: height)
        let need = fit(upright, in: screen)
        var factor = 1
        for f in [2, 4, 8] {
            let w = (Int(upright.width) + f - 1) / f, h = (Int(upright.height) + f - 1) / f
            guard CGFloat(w) >= need.width.rounded(.down), CGFloat(h) >= need.height.rounded(.down) else { break }
            factor = f
        }
        return factor
    }

    /// The EXIF orientation applied: where each stored pixel lands when the photo is upright, as a transform of
    /// Core Graphics' y-up space for a stored image `w` x `h`.
    public static func transform(orientation: Int, width w: CGFloat, height h: CGFloat) -> CGAffineTransform {
        switch orientation {
        case 2: CGAffineTransform(a: -1, b: 0, c: 0, d: 1, tx: w, ty: 0)
        case 3: CGAffineTransform(a: -1, b: 0, c: 0, d: -1, tx: w, ty: h)
        case 4: CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: h)
        case 5: CGAffineTransform(a: 0, b: -1, c: -1, d: 0, tx: h, ty: w)
        case 6: CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: 0, ty: w)
        case 7: CGAffineTransform(a: 0, b: 1, c: 1, d: 0, tx: 0, ty: 0)
        case 8: CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: h, ty: 0)
        default: .identity
        }
    }

    /// `image` decoded into a bitmap of its own, turned upright by `orientation`: a copy of the pixels, no resampling.
    /// RGBX, the layout the JPEG decoder writes: BGRA (Core Animation's own) measured 2.5 times slower to draw, since the
    /// CPU swaps every pixel, and premultiplied alpha 3 times; the GPU takes RGBX as it is. Alpha only for a photo that
    /// has it. The photo's color space is kept (an iPhone's Display P3), and the GPU matches it to the screen.
    public static func bitmap(_ image: CGImage, orientation: Int) -> CGImage? {
        let w = image.width, h = image.height
        let (ow, oh) = orientation >= 5 ? (h, w) : (w, h)
        let space = image.colorSpace.flatMap { $0.model == .rgb && $0.supportsOutput ? $0 : nil } ?? CGColorSpace(name: CGColorSpace.sRGB)!
        let opaque = [.none, .noneSkipFirst, .noneSkipLast].contains(image.alphaInfo)
        let info = (opaque ? CGImageAlphaInfo.noneSkipLast : .premultipliedLast).rawValue
        guard let ctx = CGContext(data: nil, width: ow, height: oh, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: info) else { return nil }
        ctx.interpolationQuality = .none
        ctx.concatenate(transform(orientation: orientation, width: CGFloat(w), height: CGFloat(h)))
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage()
    }

    /// Whether ImageIO reads the source as camera raw (`public.camera-raw-image` or a type that conforms to it).
    static func isRaw(_ type: String) -> Bool {
        UTType(type)?.conforms(to: .rawImage) ?? false
    }

    /// The photo's own size in pixels, upright, from its header alone (no decode).
    public static func pixelSize(at url: URL) -> (width: Int, height: Int)? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? Int, let h = props[kCGImagePropertyPixelHeight] as? Int else { return nil }
        let turned = ((props[kCGImagePropertyOrientation] as? Int) ?? 1) >= 5
        return turned ? (h, w) : (w, h)
    }

    /// How many frames it has: more than one is an animation (a GIF).
    public static func frameCount(at url: URL) -> Int {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return 0 }
        return CGImageSourceGetCount(source)
    }
}
#endif
