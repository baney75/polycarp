import QtQuick
import qs.Commons

// A look, drawn small in its own colors: its bar, its text, its accent and its three states. The colors are the theme's
// data, so this is the one place that does not use the shell's own.
Item {
  id: root

  required property var page
  required property var look
  required property string title
  property bool now: false
  property bool busy: false
  property bool hasCursor: false
  signal picked()
  signal entered()

  readonly property var c: look.colors

  implicitHeight: face.height + Style.space(6) + name.implicitHeight + Style.space(4)

  Accessible.role: Accessible.RadioButton
  Accessible.name: title
  Accessible.checked: now
  Accessible.onPressAction: root.picked()

  Rectangle {
    anchors.fill: face
    anchors.margins: -Style.space(3)
    radius: face.radius + Style.space(3)
    visible: root.hasCursor || root.now
    color: "transparent"
    border.width: Style.space(root.hasCursor ? 2 : 1)
    border.color: root.hasCursor ? Color.accent : Util.alpha(Color.popups.text, 0.4)
  }

  Rectangle {
    id: face
    x: Style.space(3)
    y: Style.space(3)
    width: parent.width - Style.space(6)
    height: Style.space(78)
    radius: Geometry.radius
    color: root.c.background
    border.width: 1
    border.color: Util.alpha(root.c.foreground, 0.16)
    opacity: root.busy ? 0.55 : 1
    Behavior on opacity { NumberAnimation { duration: root.page.host.ms(120) } }

    Rectangle {
      id: bar
      x: 1
      y: 1
      width: parent.width - 2
      height: Style.space(16)
      topLeftRadius: face.radius - 1
      topRightRadius: face.radius - 1
      color: root.c.dark_background

      Row {
        x: Style.space(7)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(4)

        Rectangle { width: Style.space(14); height: Style.space(6); radius: height / 2; color: root.c.accent }
        Rectangle { width: Style.space(6); height: width; radius: width / 2; color: root.c.muted }
        Rectangle { width: Style.space(6); height: width; radius: width / 2; color: root.c.muted }
      }

      Rectangle {
        anchors.right: parent.right
        anchors.rightMargin: Style.space(7)
        anchors.verticalCenter: parent.verticalCenter
        width: Style.space(20)
        height: Style.space(4)
        radius: height / 2
        color: root.c.bright_foreground
      }
    }

    Text {
      id: sample
      anchors.left: parent.left
      anchors.leftMargin: Style.space(9)
      anchors.top: bar.bottom
      anchors.topMargin: Style.space(5)
      textFormat: Text.PlainText
      text: "Aa"
      color: root.c.bright_foreground
      font.family: root.page.family
      font.pixelSize: Style.font.heading
      font.weight: Font.DemiBold
    }

    Column {
      anchors.left: sample.right
      anchors.leftMargin: Style.space(10)
      anchors.right: parent.right
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: sample.verticalCenter
      spacing: Style.space(5)

      Rectangle { width: parent.width; height: Style.space(4); radius: height / 2; color: root.c.foreground }
      Rectangle { width: parent.width * 0.7; height: Style.space(4); radius: height / 2; color: root.c.muted }
    }

    Row {
      anchors.left: parent.left
      anchors.leftMargin: Style.space(9)
      anchors.bottom: parent.bottom
      anchors.bottomMargin: Style.space(8)
      spacing: Style.space(6)

      Repeater {
        model: [root.c.red, root.c.yellow, root.c.green, root.c.blue, root.c.magenta]

        Rectangle {
          required property string modelData
          width: Style.space(8)
          height: width
          radius: width / 2
          color: modelData
        }
      }
    }
  }

  Text {
    id: name
    anchors.left: face.left
    anchors.leftMargin: Style.space(2)
    anchors.right: state.left
    anchors.rightMargin: Style.space(6)
    anchors.top: face.bottom
    anchors.topMargin: Style.space(6)
    textFormat: Text.PlainText
    elide: Text.ElideRight
    text: root.title
    color: Color.popups.text
    font.family: root.page.family
    font.pixelSize: Style.font.bodySmall
    font.weight: root.now ? Font.DemiBold : Font.Normal
  }

  Note {
    id: state
    page: root.page
    anchors.right: face.right
    anchors.rightMargin: Style.space(2)
    anchors.baseline: name.baseline
    wrapMode: Text.NoWrap
    text: root.busy ? root.page.strings.setting : root.now ? root.page.strings.now : ""
  }

  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onEntered: root.entered()
    onClicked: root.picked()
  }
}
