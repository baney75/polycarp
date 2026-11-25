import QtQuick
import qs.Commons
import qs.Ui

// Every open agent: the ones that want you, the ones at work, the rest. Enter or a click goes to it.
Item {
  id: root

  required property var host
  required property var view

  readonly property var service: host.service
  readonly property var strings: service ? service.strings : ({})
  readonly property var agents: service ? service.agents : []
  readonly property color ink: Color.popups.text
  readonly property string family: host.bar ? host.bar.fontFamily : Style.font.family
  property int cursor: 0

  function move(dx, dy) {
    if (agents.length > 0) cursor = Math.max(0, Math.min(agents.length - 1, cursor + (dy || dx)))
  }

  function activate() {
    go(agents[cursor])
  }

  function go(agent) {
    if (!agent) return
    host.close()
    service.focusAgent(agent)
  }

  function sectionOf(kind) {
    return kind === "needs" ? strings.needsYou : kind === "working" ? strings.working : strings.openAgents
  }

  implicitWidth: Style.space(340)
  implicitHeight: list.implicitHeight
  onAgentsChanged: if (cursor >= agents.length) cursor = Math.max(0, agents.length - 1)
  Component.onCompleted: service.lookForAgents()

  Column {
    id: list
    width: root.width
    spacing: Style.space(2)

    Text {
      width: root.width
      textFormat: Text.PlainText
      text: root.strings.agents
      color: root.ink
      font.family: root.family
      font.pixelSize: Style.font.title
      font.weight: Font.DemiBold
      bottomPadding: Style.space(4)
    }

    Text {
      visible: root.agents.length === 0
      width: root.width
      textFormat: Text.PlainText
      wrapMode: Text.WordWrap
      text: root.strings.noAgents
      color: Geometry.words
      font.family: root.family
      font.pixelSize: Style.font.body
      topPadding: Style.space(8)
      bottomPadding: Style.space(8)
    }

    Repeater {
      model: root.agents

      Column {
        id: entry
        required property var modelData
        required property int index
        readonly property bool first: index === 0 || root.agents[index - 1].kind !== modelData.kind
        width: root.width

        Text {
          visible: entry.first
          textFormat: Text.PlainText
          text: root.sectionOf(entry.modelData.kind)
          color: Geometry.words
          font.family: root.family
          font.pixelSize: Style.font.bodySmall
          topPadding: Style.space(entry.index === 0 ? 2 : 10)
          bottomPadding: Style.space(4)
        }

        CursorSurface {
          id: row
          width: parent.width
          height: Math.max(Style.space(44), words.implicitHeight + Style.space(12))
          foreground: root.ink
          hasCursor: root.cursor === entry.index
          onHasCursorChanged: if (hasCursor && root.view) root.view.reveal(row)
          Accessible.role: Accessible.Button
          Accessible.name: entry.modelData.heading + ", " + root.sectionOf(entry.modelData.kind)
          Accessible.onPressAction: root.go(entry.modelData)

          Rectangle {
            id: dot
            x: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            visible: entry.modelData.kind === "needs"
            width: Style.space(8)
            height: width
            radius: width / 2
            color: Color.accent
          }

          Ring {
            anchors.centerIn: dot
            visible: entry.modelData.kind !== "needs"
            size: Style.space(12)
            ink: Geometry.quiet(root.ink, Color.popups.background, entry.modelData.kind === "working" ? 0.85 : 0.4, 3)
          }

          Column {
            id: words
            anchors.left: dot.right
            anchors.leftMargin: Style.space(12)
            anchors.right: chip.left
            anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(1)

            Text {
              width: parent.width
              textFormat: Text.PlainText
              elide: Text.ElideRight
              text: entry.modelData.heading
              color: root.ink
              font.family: root.family
              font.pixelSize: Style.font.body
              font.weight: Font.Medium
            }

            Text {
              visible: text !== ""
              width: parent.width
              textFormat: Text.PlainText
              elide: Text.ElideMiddle
              text: entry.modelData.detail
              color: Geometry.words
              font.family: root.family
              font.pixelSize: Style.font.bodySmall
            }
          }

          Rectangle {
            id: chip
            anchors.right: parent.right
            anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            visible: label.text !== ""
            width: visible ? Math.max(Style.space(22), label.implicitWidth + Style.space(10)) : 0
            height: Style.space(20)
            radius: Geometry.radius
            color: Util.alpha(root.ink, 0.08)

            Text {
              id: label
              anchors.centerIn: parent
              textFormat: Text.PlainText
              text: root.service.workspaceOf(entry.modelData.address)
              color: root.ink
              font.family: root.family
              font.pixelSize: Style.font.bodySmall
              font.features: ({ "tnum": 1 })
            }
          }

          MouseArea {
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onEntered: root.cursor = entry.index
            onClicked: root.go(entry.modelData)
          }
        }
      }
    }
  }
}
