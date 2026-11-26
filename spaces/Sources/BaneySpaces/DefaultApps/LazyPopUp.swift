import AppKit
import SwiftUI

/// A pop-up button that holds only what it shows until it is opened. A SwiftUI `Picker` builds every choice when it is
/// drawn, and one per job of those was most of what opening Default apps cost.
struct LazyPopUp: NSViewRepresentable {
    struct Item {
        let title: String
        let image: NSImage?
        let on: Bool
        let run: () -> Void
    }

    /// What VoiceOver calls it.
    let label: String
    let shown: Item
    /// The whole list, asked for when it opens. Nil is a line between two.
    let items: () -> [Item?]

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSPopUpButton {
        let button = NSPopUpButton(frame: .zero, pullsDown: false)
        button.setAccessibilityLabel(label)
        button.setContentHuggingPriority(.defaultLow, for: .horizontal)
        button.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        (button.cell as? NSPopUpButtonCell)?.lineBreakMode = .byTruncatingTail
        button.target = context.coordinator
        button.action = #selector(Coordinator.picked(_:))
        // Sent before it opens, by a click, the keyboard or VoiceOver alike.
        NotificationCenter.default.addObserver(context.coordinator, selector: #selector(Coordinator.opening(_:)),
                                               name: NSPopUpButton.willPopUpNotification, object: button)
        return button
    }

    func updateNSView(_ button: NSPopUpButton, context: Context) {
        context.coordinator.view = self
        context.coordinator.show(in: button)
    }

    final class Coordinator: NSObject {
        var view: LazyPopUp
        private var listed: [Item?] = []

        init(_ view: LazyPopUp) { self.view = view }

        /// Only what is chosen.
        func show(in button: NSPopUpButton) {
            if listed.isEmpty, button.numberOfItems == 1, let now = button.itemArray.first,
               now.title == view.shown.title, now.image === view.shown.image { return }
            fill(button, [view.shown])
            listed = []
        }

        @objc func opening(_ note: Notification) {
            guard let button = note.object as? NSPopUpButton else { return }
            listed = view.items()
            fill(button, listed)
        }

        @objc func picked(_ button: NSPopUpButton) {
            let at = button.indexOfSelectedItem
            let item = listed.indices.contains(at) ? listed[at] : nil
            // It shows the choice when the choice is made: not "Other app…", nor one that couldn't be saved.
            show(in: button)
            item?.run()
        }

        private func fill(_ button: NSPopUpButton, _ items: [Item?]) {
            guard let menu = button.menu else { return }
            menu.removeAllItems()
            menu.autoenablesItems = false
            for item in items {
                guard let item else { menu.addItem(.separator()); continue }
                let line = NSMenuItem(title: item.title, action: nil, keyEquivalent: "")
                line.image = item.image
                menu.addItem(line)
            }
            if let on = items.firstIndex(where: { $0?.on == true }) { button.selectItem(at: on) }
        }
    }
}
