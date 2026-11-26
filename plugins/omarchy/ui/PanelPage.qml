import QtQuick
import qs.Commons

// Polycarp's own panel: looks, default apps, sync and keys, one page at a time. Tab goes on, 1 to 4 pick one.
Item {
  id: root

  required property var host
  required property var view

  readonly property var service: host.service
  readonly property var strings: service ? service.strings : ({})
  readonly property color ink: Color.popups.text
  readonly property string family: host.bar ? host.bar.fontFamily : Style.font.family
  readonly property var names: [strings.looks, strings.apps, strings.sync, strings.keys]
  property int at: 0
  readonly property bool typing: page.item ? page.item.typing === true : false

  function send(name, a, b) {
    return page.item && typeof page.item[name] === "function" ? page.item[name](a, b) : undefined
  }

  function move(dx, dy) { send("move", dx, dy) }
  function activate() { send("activate") }
  function remove() { send("remove") }
  function back() { return send("back") }
  function tab(direction) { at = (at + direction + names.length) % names.length; return true }
  function key(text) {
    var n = "1234".indexOf(text)
    if (text !== "" && n >= 0) at = n
    else send("key", text)
  }

  implicitWidth: Style.space(380)
  implicitHeight: list.implicitHeight
  onAtChanged: view.contentY = 0

  Component.onCompleted: {
    service.looks.look()
    service.apps.look()
  }

  Column {
    id: list
    width: root.width
    spacing: Style.space(12)

    Item {
      width: parent.width
      height: Math.max(mark.height, strip.height)

      Mark {
        id: mark
        anchors.verticalCenter: parent.verticalCenter
        x: Style.space(4)
        size: Style.space(20)
        ink: root.ink
      }

      Rectangle {
        id: strip
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        width: row.width + Style.space(4)
        height: row.height + Style.space(4)
        radius: Geometry.radius + Style.space(1)
        color: Util.alpha(root.ink, 0.06)

        Rectangle {
          readonly property Item under: tabs.count > root.at ? tabs.itemAt(root.at) : null
          x: under ? row.x + under.x : 0
          y: row.y
          width: under ? under.width : 0
          height: row.height
          radius: Geometry.radius
          color: Util.alpha(root.ink, 0.14)
          Behavior on x { NumberAnimation { duration: root.host.ms(140); easing.type: Easing.OutCubic } }
          Behavior on width { NumberAnimation { duration: root.host.ms(140); easing.type: Easing.OutCubic } }
        }

        Row {
          id: row
          anchors.centerIn: parent

          Repeater {
            id: tabs
            model: root.names

            Item {
              id: entry
              required property string modelData
              required property int index
              readonly property bool here: root.at === index
              width: words.implicitWidth + Style.space(22)
              height: Math.max(Style.space(26), words.implicitHeight + Style.space(8))
              Accessible.role: Accessible.PageTab
              Accessible.name: modelData
              Accessible.selected: here
              Accessible.onPressAction: root.at = index

              Text {
                id: words
                anchors.centerIn: parent
                textFormat: Text.PlainText
                text: entry.modelData
                color: entry.here || over.containsMouse ? root.ink : Geometry.words
                font.family: root.family
                font.pixelSize: Style.font.bodySmall
                font.weight: entry.here ? Font.DemiBold : Font.Normal
              }

              MouseArea {
                id: over
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.at = entry.index
              }
            }
          }
        }
      }
    }

    Loader {
      id: page
      width: parent.width
      source: ["LooksPage.qml", "AppsPage.qml", "SyncPage.qml", "KeysPage.qml"][root.at]
      onLoaded: {
        item.page = root
        item.width = Qt.binding(function() { return page.width })
      }
    }
  }
}
