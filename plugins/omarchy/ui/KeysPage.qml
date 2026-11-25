import QtQuick
import Quickshell
import qs.Commons

// The panel's keys, and the line that opens it from the keyboard. Enter or C copies that line.
Item {
  id: root

  property var page
  readonly property var strings: page ? page.strings : ({})
  readonly property string line: "o.bind(\"SUPER + ALT + P\", \"Polycarp\", \"omarchy-shell shell toggle baney75.polycarp\")"
  property bool copied: false

  function copy() {
    Quickshell.clipboardText = line
    copied = true
  }
  function activate() { copy() }
  function key(text) { if (text === "c" || text === "C") copy() }

  readonly property var rows: [
    ["← ↑ ↓ →", strings.keyArrows], ["Enter", strings.keyEnter], ["Tab", strings.keyTab], ["1 to 4", strings.keyPages],
    ["M", strings.keyMode], ["Z", strings.keyUndo], ["S", strings.keySave], ["Esc", strings.keyClose]
  ]

  implicitHeight: column.implicitHeight

  Column {
    id: column
    width: root.width
    spacing: Style.space(4)

    Repeater {
      model: root.rows

      Item {
        id: entry
        required property var modelData
        width: column.width
        height: Style.space(28)

        Text {
          x: Style.space(2)
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: entry.modelData[1] || ""
          color: Color.popups.text
          font.family: root.page ? root.page.family : Style.font.family
          font.pixelSize: Style.font.body
        }

        Rectangle {
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          width: Math.max(Style.space(26), cap.implicitWidth + Style.space(14))
          height: Style.space(22)
          radius: Geometry.radius
          color: Util.alpha(Color.popups.text, 0.08)

          Text {
            id: cap
            anchors.centerIn: parent
            textFormat: Text.PlainText
            text: entry.modelData[0]
            color: Color.popups.text
            font.family: root.page ? root.page.family : Style.font.family
            font.pixelSize: Style.font.bodySmall
          }
        }
      }
    }

    Rectangle {
      width: parent.width
      height: 1
      color: Util.alpha(Color.popups.text, 0.14)
    }

    Item {
      width: parent.width
      height: Math.max(heading.implicitHeight, button.height) + Style.space(6)

      Text {
        id: heading
        x: Style.space(2)
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: root.strings.keyOpen || ""
        color: Color.popups.text
        font.family: root.page ? root.page.family : Style.font.family
        font.pixelSize: Style.font.body
        font.weight: Font.Medium
      }

      PageButton {
        id: button
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        ink: Color.popups.text
        family: root.page ? root.page.family : ""
        held: true
        text: (root.copied ? root.strings.copied : root.strings.copy) || ""
        onClicked: root.copy()
      }
    }

    Note {
      page: root.page
      width: parent.width
      leftPadding: Style.space(2)
      text: root.strings.keyOpenText || ""
    }

    Rectangle {
      width: parent.width
      height: code.implicitHeight + Style.space(16)
      radius: Geometry.radius
      color: Util.alpha(Color.popups.text, 0.06)

      Note {
        id: code
        page: root.page
        x: Style.space(10)
        width: parent.width - Style.space(20)
        anchors.verticalCenter: parent.verticalCenter
        color: Color.popups.text
        wrapMode: Text.WrapAnywhere
        text: root.line
      }
    }
  }
}
