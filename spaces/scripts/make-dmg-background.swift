// Draws the disk image's background, at 1x and 2x for Retina:
//   swift scripts/make-dmg-background.swift build/dmg
// writes background.png (640x400) and background@2x.png (1280x800) there; package.sh combines
// them into one TIFF with `tiffutil -cathidpicheck`. The arrow runs between the two icon
// centers set in scripts/dmg-settings.py: (170, 190) and (470, 190) from the window's top left.
import AppKit

let out = CommandLine.arguments[1]
// The brand's colors (brand/README.md): Cream #F6F3E8 behind everything, Ink #2B2E26 for words, Vine green #59693F for the arrow.
func hex(_ v: Int) -> NSColor { NSColor(srgbRed: CGFloat((v >> 16) & 255) / 255, green: CGFloat((v >> 8) & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1) }
let ink = hex(0x2B2E26)
let red = hex(0x59693F)   // the arrow (named `red` before the brand colors)

func render(scale: Int, to name: String) {
    let w = 640 * scale, h = 400 * scale
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let s = CGFloat(scale)
    ctx.scaleBy(x: s, y: s)  // from here on, points; the origin is the bottom left
    // Cream, a touch lighter at the top.
    let light = CGColor(srgbRed: 0.97, green: 0.955, blue: 0.915, alpha: 1)   // a little above #F6F3E8
    let cream = hex(0xF6F3E8).cgColor
    ctx.drawLinearGradient(CGGradient(colorsSpace: nil, colors: [light, cream] as CFArray, locations: [0, 1])!,
                           start: CGPoint(x: 0, y: 400), end: CGPoint(x: 0, y: 0), options: [.drawsAfterEndLocation])

    // The arrow: a shaft and a head, at the icons' height (190 from the top).
    let y: CGFloat = 400 - 190
    ctx.setStrokeColor(red.cgColor)
    ctx.setFillColor(red.cgColor)
    ctx.setLineWidth(6)
    ctx.setLineCap(.round)
    ctx.move(to: CGPoint(x: 262, y: y))
    ctx.addLine(to: CGPoint(x: 360, y: y))
    ctx.strokePath()
    ctx.move(to: CGPoint(x: 384, y: y))
    ctx.addLine(to: CGPoint(x: 352, y: y + 20))
    ctx.addLine(to: CGPoint(x: 352, y: y - 20))
    ctx.closePath()
    ctx.fillPath()

    // Centered text; `top` is the baseline's distance from the window's top.
    func text(_ str: String, size: CGFloat, weight: NSFont.Weight, color: NSColor, top: CGFloat) {
        let font = NSFont.systemFont(ofSize: size, weight: weight)
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: str, attributes: [.font: font, .foregroundColor: color]))
        let width = CTLineGetTypographicBounds(line, nil, nil, nil)
        ctx.textPosition = CGPoint(x: (640 - width) / 2, y: 400 - top)
        CTLineDraw(line, ctx)
    }
    text("Drag Polycarp to Applications", size: 22, weight: .semibold, color: ink, top: 66)
    // For someone who has never done this: what macOS will say the first time, and what to press.
    text("The first time, your Mac may say it can't check Polycarp. That's expected:", size: 12.5, weight: .regular,
         color: ink.withAlphaComponent(0.7), top: 338)
    text("open System Settings, choose Privacy & Security, scroll down and press Open Anyway.", size: 12.5, weight: .regular,
         color: ink.withAlphaComponent(0.7), top: 358)

    // Set the size in points so the 2x file carries 144 dpi, which tiffutil needs to pair them.
    let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
    rep.size = NSSize(width: 640, height: 400)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(out)/\(name)"))
}
render(scale: 1, to: "background.png")
render(scale: 2, to: "background@2x.png")
