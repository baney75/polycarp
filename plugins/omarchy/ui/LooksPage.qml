import QtQuick
import qs.Commons
import "../lib/Strings.js" as Strings

// Polycarp's themes as Omarchy themes, and the Omarchy theme in use as Polycarp's. M turns them dark or light, Z undoes,
// S saves.
Item {
  id: root

  property var page
  readonly property var looks: page && page.service ? page.service.looks : null
  readonly property var strings: page ? page.strings : ({})
  readonly property var all: looks ? looks.looks : []
  readonly property var list: looks ? looks.list : ({})
  property string mode: ""
  property int cursor: 0
  readonly property var under: all.length > 0 ? all[Math.min(cursor, all.length - 1)] : null

  // Opens on the mode in use.
  readonly property string used: list.colors && list.colors.mode === "light" ? "light" : "dark"
  readonly property string shown: mode !== "" ? mode : used

  function move(dx, dy) {
    var next = cursor + dx + dy * 2
    if (next >= 0 && next < all.length) cursor = next
  }

  function activate() { pick(under) }
  function pick(entry) { if (entry) looks.apply(entry[shown]) }
  function key(text) {
    var k = text.toLowerCase()
    if (k === "m") mode = shown === "dark" ? "light" : "dark"
    else if (k === "z" || k === "u") looks.undo()
    else if (k === "s") looks.save()
  }
  function remove() { looks.forget() }

  // What the look under the cursor is, or how the last action went.
  readonly property string words: {
    if (!looks || !under) return ""
    if (looks.said !== "") return looks.said
    var look = under[shown]
    if (under.taken[shown]) return strings.looksLeft
    if (look.misses.length > 0) {
      var m = look.misses[0]
      return Strings.fill(strings.pairMisses, m.role, m.ground, m.ratio, m.least)
    }
    return (under.description + " " + strings.looksFont).trim()
  }

  implicitHeight: column.implicitHeight

  Column {
    id: column
    width: root.width
    spacing: Style.space(10)

    Item {
      width: parent.width
      height: modes.height

      Row {
        id: modes
        spacing: Style.space(2)

        Repeater {
          model: ["dark", "light"]

          PageButton {
            required property string modelData
            ink: root.shown === modelData ? Color.popups.text : Geometry.words
            family: root.page ? root.page.family : ""
            held: root.shown === modelData
            text: root.strings[modelData] || ""
            onClicked: root.mode = modelData
          }
        }
      }

      PageButton {
        anchors.right: parent.right
        visible: root.list.undo === true
        ink: Color.popups.text
        family: root.page ? root.page.family : ""
        text: root.strings.undo || ""
        onClicked: root.looks.undo()
      }
    }

    Grid {
      id: grid
      width: parent.width
      columns: 2
      columnSpacing: Style.space(6)
      rowSpacing: Style.space(8)

      Repeater {
        model: root.all

        LookCard {
          id: card
          required property var modelData
          required property int index
          page: root.page
          width: (grid.width - grid.columnSpacing) / 2
          look: modelData[root.shown]
          title: modelData.title
          now: root.list.theme === look.id
          busy: root.looks.busy === "apply " + look.id
          hasCursor: root.cursor === index
          onHasCursorChanged: if (hasCursor && root.page) root.page.view.reveal(card)
          onEntered: root.cursor = index
          onPicked: root.pick(modelData)
        }
      }
    }

    Note {
      page: root.page
      width: parent.width
      // Two lines are always kept, so the panel does not change height as the cursor goes.
      height: Math.max(implicitHeight, metrics.height * 2 * lineHeight)
      text: root.words

      FontMetrics {
        id: metrics
        font.family: root.page ? root.page.family : Style.font.family
        font.pixelSize: Style.font.bodySmall
      }
    }

    Rectangle {
      visible: omarchy.visible
      width: parent.width
      height: 1
      color: Util.alpha(Color.popups.text, 0.14)
    }

    Item {
      id: omarchy
      readonly property var here: root.looks ? root.looks.here : null
      visible: here !== null
      width: parent.width
      height: visible ? Math.max(about.implicitHeight, buttons.height) : 0

      Column {
        id: about
        anchors.left: parent.left
        anchors.right: buttons.left
        anchors.rightMargin: Style.space(10)
        spacing: Style.space(2)

        Text {
          width: parent.width
          textFormat: Text.PlainText
          elide: Text.ElideRight
          text: omarchy.here ? Strings.fill(root.strings.fromOmarchy, omarchy.here.title) : ""
          color: Color.popups.text
          font.family: root.page ? root.page.family : Style.font.family
          font.pixelSize: Style.font.body
          font.weight: Font.Medium
        }

        Note {
          page: root.page
          width: parent.width
          text: !omarchy.here ? "" : omarchy.here.fitted.length === 0 ? root.strings.fromOmarchyHint
            : Strings.fill(root.strings.fitted, omarchy.here.fitted.map(function(f) { return Strings.fill(root.strings.fittedOne, f.role, f.ratio) }).join(", "))
        }
      }

      Row {
        id: buttons
        anchors.right: parent.right

        PageButton {
          visible: omarchy.here !== null && root.looks.saved && root.list.taken[omarchy.here.id] !== true
          ink: Color.popups.text
          family: root.page ? root.page.family : ""
          held: true
          text: root.strings.removeIt || ""
          onClicked: root.looks.forget()
        }

        PageButton {
          visible: root.looks !== null && !root.looks.saved
          ink: Color.popups.text
          family: root.page ? root.page.family : ""
          held: true
          text: root.strings.save || ""
          onClicked: root.looks.save()
        }
      }
    }
  }
}
