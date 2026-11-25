import QtQuick
import qs.Commons

// Polycarp's mark. It opens the panel.
Slot {
  id: root

  slot: Style.bar.iconSlot
  held: host.part === "panel"
  tip: host.service.strings.open
  onPressed: function(button) { if (button === Qt.LeftButton) host.togglePart("panel", root) }

  Component.onCompleted: host.service.marks += 1
  Component.onDestruction: if (host.service) host.service.marks -= 1

  Mark {
    size: Style.bar.iconCanvas
    ink: root.ink
  }
}
