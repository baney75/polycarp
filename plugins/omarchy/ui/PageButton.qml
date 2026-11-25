import QtQuick
import qs.Commons

// A small button in a panel: a word, or a chevron pointing back (-1) or on (1).
Item {
  id: root

  property color ink
  property string family: Style.font.family
  property string text: ""
  property string name: text
  property int chevron: 0
  property bool hasCursor: false
  // The one of a set that is chosen, or the one a page is for.
  property bool held: false
  property int role: Accessible.Button
  signal clicked()

  implicitWidth: chevron !== 0 ? Style.space(28) : label.implicitWidth + Style.space(16)
  implicitHeight: Math.max(Style.space(26), label.implicitHeight + Style.space(6))

  Accessible.role: root.role
  Accessible.checked: root.held
  Accessible.name: name
  Accessible.onPressAction: root.clicked()

  Rectangle {
    anchors.fill: parent
    radius: Geometry.radius
    color: area.pressed ? Style.pressedFillFor(root.ink, Color.accent)
      : area.containsMouse ? Style.hoverFillFor(root.ink, Color.accent) : Util.alpha(root.ink, root.held ? 0.14 : 0)
    border.width: root.hasCursor ? Style.space(2) : 0
    border.color: Color.accent
  }

  Text {
    id: label
    anchors.centerIn: parent
    visible: root.chevron === 0
    textFormat: Text.PlainText
    text: root.text
    color: root.ink
    font.family: root.family
    font.pixelSize: Style.font.bodySmall
  }

  Chevron {
    anchors.centerIn: parent
    visible: root.chevron !== 0
    size: Style.space(9)
    ink: root.ink
    rotation: root.chevron < 0 ? 180 : 0
  }

  MouseArea {
    id: area
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onClicked: root.clicked()
  }
}
