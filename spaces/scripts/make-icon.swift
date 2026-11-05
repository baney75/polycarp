// Draws the Polycarp icon from the brand's olive branch (brand/mark.svg, brand/mark-small.svg):
// the branch in vine green on a cream squircle, at the sizes an .icns needs. Also the menu bar's
// template image: the small mark in black on clear, which macOS tints for light, dark and
// highlighted menu bars.
//   swift scripts/make-icon.swift build/Polycarp.iconset ../brand
//   swift scripts/make-icon.swift --menu-bar build/Polycarp.app/Contents/Resources ../brand
// Colors are the brand palette (brand/README.md): Cream #F6F3E8, Vine green #59693F.
import AppKit

let args = Array(CommandLine.arguments.dropFirst())
let menuBar = args.first == "--menu-bar"
let rest = menuBar ? Array(args.dropFirst()) : args
guard rest.count == 2 else {
    FileHandle.standardError.write(Data("usage: make-icon.swift [--menu-bar] <output folder> <brand folder>\n".utf8))
    exit(2)
}
let out = URL(fileURLWithPath: rest[0])
let brand = URL(fileURLWithPath: rest[1])
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

let cream = NSColor(srgbRed: 0xF6 / 255, green: 0xF3 / 255, blue: 0xE8 / 255, alpha: 1)
let vine = "#59693F"

/// The mark as an image, its `currentColor` set to `hex`. Fails loudly: an icon that silently
/// came out blank would ship.
func mark(_ file: String, color hex: String) -> NSImage {
    let url = brand.appendingPathComponent(file)
    guard var svg = try? String(contentsOf: url, encoding: .utf8) else { fatalError("make-icon: can't read \(url.path)") }
    svg = svg.replacingOccurrences(of: ##"color="#000""##, with: "color=\"\(hex)\"")
    guard let image = NSImage(data: Data(svg.utf8)), image.size.width > 0 else { fatalError("make-icon: can't draw \(file)") }
    return image
}

func png(_ px: Int, _ draw: (CGFloat) -> Void) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    draw(CGFloat(px))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let full = mark("mark.svg", color: vine)
let small = mark("mark-small.svg", color: vine)

func icon(_ px: Int) -> Data {
    png(px) { s in
        // macOS icon grid: the shape fills about 80% of the canvas (brand/icon-macos.svg: 100 of 1024 in, radius 186).
        let inset = s * 100 / 1024, body = CGRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
        let r = body.width * 186 / 824
        cream.setFill()
        NSBezierPath(roundedRect: body, xRadius: r, yRadius: r).fill()
        // The mark's 64-unit box is 700 of 1024 wide, 162 from the edge. The simpler mark below 48 px.
        let side = s * 700 / 1024, at = s * 162 / 1024
        (px < 48 ? small : full).draw(in: CGRect(x: at, y: at, width: side, height: side))
    }
}

if menuBar {
    // 18 pt tall as the menu bar draws it, @1x and @2x. Black on clear: macOS tints a template.
    let template = mark("mark-small.svg", color: "#000000")
    for (px, name) in [(18, "MenuBarMark.png"), (36, "MenuBarMark@2x.png")] {
        try png(px) { s in template.draw(in: CGRect(x: 0, y: 0, width: s, height: s)) }
            .write(to: out.appendingPathComponent(name))
    }
} else {
    for size in [16, 32, 128, 256, 512] {
        try icon(size).write(to: out.appendingPathComponent("icon_\(size)x\(size).png"))
        try icon(size * 2).write(to: out.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
    }
}
