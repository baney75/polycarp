import AppKit
import BaneySpacesCore
import SwiftUI

/// The top of the menu bar menu ("Now first"): what you are doing, and the two small prompts that name it.
enum MenuHead {
    /// The purpose in serif italic, with the workspace and the time it started on a smaller line. No colors are set, so
    /// AppKit draws the row's highlight and the menu's own text colors in light and dark.
    static func title(_ now: MenuNow) -> NSAttributedString {
        let size = NSFont.systemFontSize + 2
        let base = NSFont.systemFont(ofSize: size)
        let serif = base.fontDescriptor.withDesign(.serif)?.withSymbolicTraits(.italic)
        let head = serif.flatMap { NSFont(descriptor: $0, size: size) } ?? base
        let small = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize, weight: .medium)
        let out = NSMutableAttributedString(string: now.title, attributes: [.font: head])
        out.append(NSAttributedString(string: "\n" + now.detail, attributes: [.font: small]))
        return out
    }

    /// A small sheet with one line of text: Keep saves it through `save`, which may refuse it (too long). A refusal
    /// says why and asks again with the text kept.
    static func ask(_ question: String, info: String, value: String, save: (String) throws -> Void) {
        NSApp.activate(ignoringOtherApps: true)
        var text = value
        while true {
            let alert = NSAlert()
            alert.messageText = question
            alert.informativeText = info
            let field = NSTextField(string: text)
            field.frame = NSRect(x: 0, y: 0, width: 300, height: 24)
            field.lineBreakMode = .byTruncatingTail
            alert.accessoryView = field
            alert.addButton(withTitle: "Keep")
            alert.addButton(withTitle: "Cancel")
            alert.window.initialFirstResponder = field
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            text = field.stringValue
            do {
                try save(text)
                return
            } catch {
                let problem = NSAlert()
                let p = error as? Purposes.Problem
                if case .tooLong = p { problem.messageText = "That didn't fit" } else { problem.messageText = "That couldn't be kept" }
                problem.informativeText = p?.description ?? error.localizedDescription
                problem.runModal()
            }
        }
    }
}
