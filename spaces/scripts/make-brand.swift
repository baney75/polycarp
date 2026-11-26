// Draws the Spaces README banner and the GitHub social card from the Polycarp icon, in the same layout as
// Yapshot's:
//   swift scripts/make-brand.swift build/Polycarp.iconset/icon_512x512@2x.png docs
// `make brand` draws the icon first, then runs this.
import AppKit

let icon = NSImage(contentsOfFile: CommandLine.arguments[1])!.cgImage(forProposedRect: nil, context: nil, hints: nil)!
let out = CommandLine.arguments[2]
// The brand's colors (brand/README.md), the name in Cream #F6F3E8 and the system serif (the brand's Newsreader is for the
// wordmark; this draws text): Ink #2B2E26 under a lighter step of it, a glow of Vine on dark #A9BB8A, and
// Old gold on dark #C7B07A for the byline. Red is only for errors.
let ink = CGColor(srgbRed: 0.169, green: 0.180, blue: 0.149, alpha: 1)
let inkTop = CGColor(srgbRed: 0.231, green: 0.247, blue: 0.204, alpha: 1)
let vine = NSColor(srgbRed: 0.663, green: 0.733, blue: 0.541, alpha: 1)
let gold = NSColor(srgbRed: 0.780, green: 0.690, blue: 0.478, alpha: 1)

func render(_ w: Int, _ h: Int, iconSize: CGFloat, title: CGFloat, to name: String) {
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let W = CGFloat(w), H = CGFloat(h)
    ctx.drawLinearGradient(CGGradient(colorsSpace: nil, colors: [inkTop, ink] as CFArray, locations: [0, 1])!,
                           start: CGPoint(x: 0, y: H), end: CGPoint(x: W * 0.6, y: 0), options: [.drawsAfterEndLocation])
    let glow = [vine.withAlphaComponent(0.16).cgColor, vine.withAlphaComponent(0).cgColor]
    ctx.drawRadialGradient(CGGradient(colorsSpace: nil, colors: glow as CFArray, locations: [0, 1])!,
                           startCenter: CGPoint(x: W * 0.2, y: H * 0.5), startRadius: 0,
                           endCenter: CGPoint(x: W * 0.2, y: H * 0.5), endRadius: W * 0.32, options: [])
    let left = W * 0.08
    let iconRect = CGRect(x: left, y: (H - iconSize) / 2, width: iconSize, height: iconSize)
    ctx.draw(icon, in: iconRect)
    // The icon is dark slate on dark slate; a hairline keeps its edge (make-icon's 80% body, 22.5% corner).
    let body = iconRect.insetBy(dx: iconSize * 0.1, dy: iconSize * 0.1)
    ctx.addPath(CGPath(roundedRect: body.insetBy(dx: 1, dy: 1), cornerWidth: body.width * 0.225, cornerHeight: body.width * 0.225, transform: nil))
    ctx.setStrokeColor(CGColor(gray: 1, alpha: 0.12))
    ctx.setLineWidth(2)
    ctx.strokePath()
    let x = left + iconSize + W * 0.045
    // Each line shrinks if it would run past the right margin (the social card is narrower than the banner).
    func text(_ s: String, size: CGFloat, weight: NSFont.Weight, serif: Bool = false, color: NSColor, at p: CGPoint) {
        func font(_ size: CGFloat) -> NSFont {
            let f = NSFont.systemFont(ofSize: size, weight: weight)
            guard serif, let d = f.fontDescriptor.withDesign(.serif) else { return f }
            return NSFont(descriptor: d, size: size) ?? f
        }
        func line(_ size: CGFloat) -> CTLine {
            CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: [.font: font(size), .foregroundColor: color]))
        }
        let room = W * 0.95 - p.x, width = CTLineGetTypographicBounds(line(size), nil, nil, nil)
        ctx.textPosition = p
        CTLineDraw(line(width > room ? size * room / width : size), ctx)
    }
    text("Polycarp", size: title, weight: .semibold, serif: true, color: NSColor(srgbRed: 0.965, green: 0.953, blue: 0.910, alpha: 1), at: CGPoint(x: x, y: H / 2 + title * 0.12))
    text("Nine workspaces. One row of keys.", size: title * 0.38, weight: .semibold, color: NSColor(white: 1, alpha: 0.86),
         at: CGPoint(x: x, y: H / 2 - title * 0.42))
    text("Free for macOS. ⌘1–⌘9 switches; add ⇧ and the window comes with you.", size: title * 0.235, weight: .regular,
         color: NSColor(white: 1, alpha: 0.6), at: CGPoint(x: x, y: H / 2 - title * 0.82))
    text("by Donovan Baney  ·  dbaney.com", size: title * 0.235, weight: .medium,
         color: gold, at: CGPoint(x: x, y: H / 2 - title * 1.14))
    let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(out)/\(name)"))
}
render(1600, 560, iconSize: 340, title: 112, to: "banner.png")
render(1280, 640, iconSize: 340, title: 100, to: "social-card.png")
