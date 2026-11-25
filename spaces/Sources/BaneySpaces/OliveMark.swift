import SwiftUI

/// Polycarp's small mark (`brand/mark-small.svg`, the one its README asks for in a bar), drawn on its own 64 point grid
/// in one ink.
struct OliveMark: Shape {
    func path(in rect: CGRect) -> Path {
        // One outline: leaves, stem and olive wind their own ways, and where they overlap a plain sum leaves holes.
        var p = CGMutablePath() as CGPath
        func at(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }
        var stem = Path()
        stem.move(to: at(8, 58))
        stem.addCurve(to: at(42, 23), control1: at(20, 49), control2: at(33, 36))
        p = p.union(stem.strokedPath(StrokeStyle(lineWidth: 5.4, lineCap: .round)).cgPath)
        // Each leaf is out along one curve and back along another.
        for (from, out, tip, back) in [(at(42, 23), (at(52.4, 21.9), at(55.8, 12.1)), at(54.2, 3.5), (at(45.8, 5.8), at(38.5, 13.2))),
                                       (at(35, 31.5), (at(40.6, 23.5), at(36.2, 14.1)), at(29.4, 9.2), (at(25.8, 16.7), at(26.3, 27))),
                                       (at(39, 27), (at(45.8, 33.1), at(54.7, 29.9)), at(59.8, 24.1), (at(53.3, 19.9), at(43.8, 19.2)))] {
            var leaf = Path()
            leaf.move(to: from)
            leaf.addCurve(to: tip, control1: out.0, control2: out.1)
            leaf.addCurve(to: from, control1: back.0, control2: back.1)
            p = p.union(leaf.cgPath)
        }
        let olive = CGAffineTransform(translationX: 29, y: 52).rotated(by: -12 * .pi / 180)
        p = p.union(Path(ellipseIn: CGRect(x: -9.2, y: -10.6, width: 18.4, height: 21.2)).applying(olive).cgPath)
        let scale = min(rect.width, rect.height) / 64
        return Path(p).applying(CGAffineTransform(translationX: rect.minX, y: rect.minY).scaledBy(x: scale, y: scale))
    }
}
