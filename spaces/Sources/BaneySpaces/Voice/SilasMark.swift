import AppKit
import BaneySpacesCore
import SwiftUI

/// Silas's pen, for the places that used a microphone: the Settings tab, the status mark in Settings and the menu bar. Vector, so
/// it is crisp at menu bar size and at 64 pt. `SilasMarkGeometry` has the shape.
struct SilasMarkShape: Shape {
    var part: Part = .pen
    enum Part { case pen, dot }
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / SilasMarkGeometry.grid
        let t = CGAffineTransform(translationX: rect.minX + (rect.width - SilasMarkGeometry.grid * s) / 2,
                                  y: rect.minY + (rect.height - SilasMarkGeometry.grid * s) / 2).scaledBy(x: s, y: s)
        return Path(part == .pen ? SilasMarkGeometry.pen() : SilasMarkGeometry.dot()).applying(t)
    }
}

/// The pen in the current text color; while listening, the dot beside it in the accent.
struct SilasMarkView: View {
    var live = false
    var size: CGFloat = 18
    var body: some View {
        ZStack {
            SilasMarkShape().fill(style: FillStyle(eoFill: true))
            if live { SilasMarkShape(part: .dot).fill(Chrome.accent) }
        }
        .frame(width: size, height: size)
        .accessibilityLabel("Silas")
    }
}
