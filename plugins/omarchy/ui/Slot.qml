import QtQuick
import qs.Commons

// A bar button: one slot, a soft face under the pointer, a small press. The whole depth of the bar takes the click, so
// the pointer can rest on the screen's edge.
Item {
  id: root

  required property var host
  property real slot: Style.bar.iconSlot
  property real inset: 0
  // Held down by what it opened.
  property bool held: false
  // The pill under it is the face; it draws none of its own.
  property bool plain: false
  property string tip: ""
  property string name: tip

  readonly property var bar: host.bar
  readonly property bool vertical: host.vertical
  readonly property color ink: bar ? bar.barForeground : Color.foreground
  readonly property color accent: Color.accent
  readonly property bool hovered: area.containsMouse
  // The bar asks this before it shows a tooltip it was asked for a moment ago.
  readonly property bool tooltipHovered: visible && hovered
  default property alias content: holder.data

  signal pressed(int button)
  signal wheeled(int delta)

  function triggerPress(button) {
    if (bar) bar.hideTooltip(root)
    pressed(button)
  }

  implicitWidth: vertical ? host.barSize : Math.max(slot, holder.implicitWidth + inset * 2)
  implicitHeight: vertical ? Math.max(slot, holder.implicitHeight + inset * 2) : host.barSize

  Accessible.role: Accessible.Button
  Accessible.name: name
  Accessible.onPressAction: root.pressed(Qt.LeftButton)

  Rectangle {
    anchors.centerIn: parent
    width: root.vertical ? Geometry.face(root.host.barSize) : parent.width
    height: root.vertical ? parent.height : Geometry.face(root.host.barSize)
    radius: Geometry.radius
    color: area.pressed ? Style.pressedFillFor(root.ink, root.accent)
      : root.held ? Style.selectedFillFor(root.ink, root.accent)
      : area.containsMouse && !root.plain ? Style.hoverFillFor(root.ink, root.accent)
      : Util.alpha(root.ink, 0)

    Behavior on color {
      ColorAnimation { duration: root.host.ms(area.containsMouse ? 90 : 160) }
    }
  }

  Item {
    id: holder
    anchors.centerIn: parent
    implicitWidth: childrenRect.width
    implicitHeight: childrenRect.height
    width: implicitWidth
    height: implicitHeight
    scale: area.pressed && !root.host.still ? 0.92 : 1

    Behavior on scale {
      NumberAnimation { duration: root.host.ms(160); easing.type: Easing.OutCubic }
    }
  }

  MouseArea {
    id: area
    anchors.fill: parent
    hoverEnabled: true
    acceptedButtons: Qt.LeftButton | Qt.RightButton
    cursorShape: Qt.PointingHandCursor
    onEntered: if (root.bar && root.tip) root.bar.showTooltip(root, root.tip)
    onExited: if (root.bar) root.bar.hideTooltip(root)
    onClicked: function(mouse) { root.triggerPress(mouse.button) }
    onWheel: function(wheel) { root.wheeled(wheel.angleDelta.y !== 0 ? wheel.angleDelta.y : wheel.angleDelta.x) }
  }

  onVisibleChanged: if (!visible && bar) bar.hideTooltip(root)

  // A press on the bar while a panel is open reaches the bar's buttons through this list.
  property var registered: null
  function register() {
    if (registered && registered.unregisterClickTarget) registered.unregisterClickTarget(root)
    registered = bar
    if (registered && registered.registerClickTarget) registered.registerClickTarget(root)
  }
  onBarChanged: register()
  Component.onCompleted: register()
  Component.onDestruction: if (registered && registered.unregisterClickTarget) registered.unregisterClickTarget(root)
}
