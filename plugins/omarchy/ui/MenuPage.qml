import QtQuick
import Quickshell
import Quickshell.Widgets
import qs.Commons
import qs.Ui

// A tray app's own menu, one level at a time. Right goes into a submenu, left or Escape back out.
Item {
  id: root

  required property var host
  required property var view

  readonly property var strings: host.service ? host.service.strings : ({})
  readonly property color ink: Color.popups.text
  readonly property string family: host.bar ? host.bar.fontFamily : Style.font.family
  // The submenus entered, outermost first. A child belongs to its parent's opener, so every level keeps its own.
  property var levels: []
  readonly property var entries: levels.length > 0 ? levels[levels.length - 1].opener.children : top.children
  readonly property int count: entries ? entries.values.length : 0
  property int cursor: -1

  function at(i) {
    return entries && i >= 0 && i < count ? entries.values[i] : null
  }

  function pickable(i) {
    var e = at(i)
    return e !== null && !e.isSeparator && e.enabled
  }

  function move(dx, dy) {
    if (dx > 0 && at(cursor) && at(cursor).hasChildren) return enter(at(cursor))
    if (dx < 0) return back()
    for (var i = cursor + (dy > 0 ? 1 : -1); dy !== 0 && i >= 0 && i < count; i += dy > 0 ? 1 : -1) {
      if (!pickable(i)) continue
      cursor = i
      return true
    }
    return false
  }

  function activate() {
    pick(cursor)
  }

  function pick(i) {
    if (!pickable(i)) return
    if (at(i).hasChildren) enter(at(i))
    else {
      at(i).triggered()
      host.close()
    }
  }

  function enter(entry) {
    levels = levels.concat([{ opener: opener.createObject(root, { menu: entry }), title: entry.text }])
    cursor = -1
    return true
  }

  function back() {
    if (levels.length === 0) return false
    var last = levels[levels.length - 1]
    levels = levels.slice(0, -1)
    last.opener.destroy()
    cursor = -1
    return true
  }

  implicitWidth: Style.space(260)
  implicitHeight: list.implicitHeight
  Component.onDestruction: { while (levels.length > 0) back() }

  QsMenuOpener {
    id: top
    menu: root.host.trayItem ? root.host.trayItem.menu : null
  }

  Component { id: opener; QsMenuOpener {} }

  Column {
    id: list
    width: root.width

    Text {
      width: parent.width
      textFormat: Text.PlainText
      elide: Text.ElideRight
      text: root.levels.length > 0 ? root.levels[root.levels.length - 1].title
        : root.host.trayItem ? root.host.trayItem.title || root.host.trayItem.id : ""
      color: Geometry.words
      font.family: root.family
      font.pixelSize: Style.font.bodySmall
      leftPadding: Style.space(8)
      bottomPadding: Style.space(6)
    }

    Repeater {
      model: root.entries

      Item {
        id: line
        required property var modelData
        required property int index
        width: list.width
        height: modelData.isSeparator ? Style.space(9) : Math.max(Style.space(30), words.implicitHeight + Style.space(8))

        Rectangle {
          visible: line.modelData.isSeparator
          anchors.verticalCenter: parent.verticalCenter
          width: parent.width
          height: 1
          color: Util.alpha(root.ink, 0.14)
        }

        CursorSurface {
          anchors.fill: parent
          visible: !line.modelData.isSeparator
          foreground: root.ink
          hasCursor: root.cursor === line.index
          onHasCursorChanged: if (hasCursor && root.view) root.view.reveal(line)

          IconImage {
            id: icon
            x: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            visible: line.modelData.icon !== ""
            implicitSize: Style.space(16)
            source: line.modelData.icon
          }

          Text {
            id: words
            anchors.verticalCenter: parent.verticalCenter
            x: icon.visible ? Style.space(32) : Style.space(8)
            width: parent.width - x - Style.space(28)
            textFormat: Text.PlainText
            elide: Text.ElideRight
            text: line.modelData.text
            color: Util.alpha(root.ink, line.modelData.enabled ? 1 : 0.45)
            font.family: root.family
            font.pixelSize: Style.font.body
            Accessible.role: Accessible.MenuItem
            Accessible.name: text
          }

          Chevron {
            anchors.right: parent.right
            anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            visible: line.modelData.hasChildren
            ink: Geometry.words
          }

          Rectangle {
            anchors.right: parent.right
            anchors.rightMargin: Style.space(9)
            anchors.verticalCenter: parent.verticalCenter
            visible: !line.modelData.hasChildren && line.modelData.checkState === Qt.Checked
            width: Style.space(7)
            height: width
            radius: line.modelData.buttonType === QsMenuButtonType.RadioButton ? width / 2 : Math.min(Geometry.radius, width / 3)
            color: Color.accent
          }

          MouseArea {
            anchors.fill: parent
            hoverEnabled: true
            enabled: line.modelData.enabled
            onEntered: root.cursor = line.index
            onClicked: root.pick(line.index)
          }
        }
      }
    }
  }
}
