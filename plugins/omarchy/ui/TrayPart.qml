import QtQuick
import Quickshell
import Quickshell.Services.SystemTray
import Quickshell.Widgets
import qs.Commons

// The tray in a drawer: a chevron, and behind it each app's icon in a slot of its own. It opens under the pointer and
// closes a moment after it leaves; a click on the chevron keeps it open.
Item {
  id: root

  required property var host

  readonly property var strings: host.service.strings
  readonly property bool vertical: host.vertical
  readonly property var items: SystemTray.items.values.filter(function(item) { return item.status !== Status.Passive })
  readonly property bool any: items.length > 0
  // In the far half of the bar the chevron comes last, so it stays under the pointer as the icons come out before it.
  property bool far: false
  property bool kept: false
  property bool lingering: false
  readonly property bool holding: host.part === "tray"
  readonly property bool expanded: kept || hover.hovered || lingering || holding
  readonly property real run: items.length * Style.bar.iconSlot
  property real reveal: expanded ? 1 : 0
  readonly property real shown: Math.round(run * reveal)

  Behavior on reveal { NumberAnimation { duration: root.host.ms(220); easing.type: Easing.OutQuint } }

  visible: any
  implicitWidth: !any ? 0 : vertical ? host.barSize : chevron.implicitWidth + shown
  implicitHeight: !any ? 0 : vertical ? chevron.implicitHeight + shown : host.barSize

  function act(item, button, slot) {
    if (button === Qt.RightButton || item.onlyMenu) {
      if (item.hasMenu) {
        host.trayItem = item
        host.togglePart("tray", slot)
      } else item.secondaryActivate()
    } else item.activate()
  }

  function place() {
    var window = root.QsWindow.window
    if (!window) return
    var at = root.mapToItem(window.contentItem, 0, 0)
    far = vertical ? at.y > window.height / 2 : at.x > window.width / 2
  }

  onAnyChanged: Qt.callLater(place)
  // An app that leaves the tray takes its open menu with it.
  onItemsChanged: if (holding && items.indexOf(host.trayItem) < 0) host.close()
  Component.onCompleted: Qt.callLater(place)

  HoverHandler {
    id: hover
    onHoveredChanged: {
      root.place()
      if (!hovered) linger.restart()
      root.lingering = !hovered
    }
  }

  // Once, after the pointer leaves.
  Timer {
    id: linger
    interval: 500
    onTriggered: root.lingering = false
  }

  Slot {
    id: chevron
    x: root.vertical || !root.far ? 0 : root.shown
    y: root.vertical && root.far ? root.shown : 0
    host: root.host
    slot: Style.space(20)
    tip: root.kept ? root.strings.drawerClose : root.strings.drawerKeep
    onPressed: function(button) { if (button === Qt.LeftButton) root.kept = !root.kept }

    Chevron {
      size: Style.space(9)
      ink: Util.alpha(chevron.ink, 0.72)
      // Points at where the icons come from, and back once they are out.
      rotation: (root.vertical ? 90 : 0) + 180 * (root.far ? 1 - root.reveal : root.reveal)
    }
  }

  Item {
    x: root.vertical || root.far ? 0 : chevron.width
    y: root.vertical && !root.far ? chevron.height : 0
    width: root.vertical ? root.width : root.shown
    height: root.vertical ? root.shown : root.height
    clip: true
    visible: root.shown > 0
    opacity: root.reveal

    Line {
      vertical: root.vertical

      Repeater {
        model: root.items

        Slot {
          id: slot
          required property var modelData
          host: root.host
          held: root.holding && root.host.trayItem === modelData
          tip: modelData.tooltipTitle || modelData.title || modelData.id || ""
          onPressed: function(button) { root.act(modelData, button, slot) }
          onWheeled: function(delta) { modelData.scroll(delta, false) }

          IconImage {
            implicitSize: Style.bar.iconCanvas
            source: slot.modelData.icon
            asynchronous: true
          }
        }
      }
    }
  }
}
